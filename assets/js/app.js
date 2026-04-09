"use strict";

/**
 * このアプリは画像をサーバーへ送らず、ブラウザ内だけで検査と変換を完結させる。
 * そのため、受け付ける形式・サイズ・解像度を先に厳しく確認してから、
 * 安全と判断したデータだけを Worker に渡して JPG を生成する。
 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 1;
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_IMAGE_WIDTH = 8192;
const MAX_IMAGE_HEIGHT = 8192;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_SVG_BYTES = 2 * 1024 * 1024;
const MAX_SVG_ELEMENTS = 5000;
const PROCESS_TIMEOUT_MS = 15_000;
const JPEG_QUALITY_MIN = 0.42;
const DEFAULT_JPEG_QUALITY = 0.82;
const ALLOWED_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "ico",
  "jfif",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "tif",
  "tiff",
  "webp"
]);
const IMAGE_BRANDS = new Set(["avif", "avis", "heic", "heix", "hevc", "hevx", "mif1", "msf1"]);
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const SVG_DANGEROUS_TAGS = new Set([
  "script",
  "style",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
  "canvas",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "discard"
]);

const state = {
  isProcessing: false,
  pendingFiles: [],
  objectUrls: new Set(),
  worker: null,
  nextJobId: 1,
  pendingJobs: new Map(),
  summary: {
    processed: 0,
    rejected: 0,
    totalInputBytes: 0,
    totalOutputBytes: 0
  }
};

const elements = {
  dropzone: document.querySelector("#dropzone"),
  dropzoneStateBadge: document.querySelector("#dropzone-state-badge"),
  dropzoneTitle: document.querySelector("#dropzone-title"),
  dropzoneSubtitle: document.querySelector("#dropzone-subtitle"),
  dropzoneNote: document.querySelector("#dropzone-note"),
  fileInput: document.querySelector("#file-input"),
  selectButton: document.querySelector("#select-button"),
  convertButton: document.querySelector("#convert-button"),
  clearButton: document.querySelector("#clear-button"),
  qualityRange: document.querySelector("#quality-range"),
  qualityValue: document.querySelector("#quality-value"),
  statusMessage: document.querySelector("#status-message"),
  resultsList: document.querySelector("#results-list"),
  emptyState: document.querySelector("#empty-state"),
  processedCount: document.querySelector("#processed-count"),
  rejectedCount: document.querySelector("#rejected-count"),
  savedSize: document.querySelector("#saved-size"),
  averageRatio: document.querySelector("#average-ratio")
};

boot();

/**
 * 初期表示を整え、イベントを結び付ける。
 * 安全な変換に必要な API が足りないブラウザでは、最初から操作を無効化する。
 */
function boot() {
  elements.qualityRange.value = String(Math.round(DEFAULT_JPEG_QUALITY * 100));
  updateQualityLabel();
  updateSummary();
  syncEmptyState();
  updatePendingSelection();
  bindEvents();

  if (!browserSupportsSecurePipeline()) {
    setStatus("このブラウザは安全な変換ワーカーに未対応です。最新の主要ブラウザで開いてください。", "danger");
    setInteractiveEnabled(false);
    elements.dropzone.setAttribute("aria-disabled", "true");
  }
}

/**
 * 画面上の操作と内部処理を結び付ける。
 * ファイル選択、ドラッグ操作、離脱時の後始末などをここで登録する。
 */
function bindEvents() {
  elements.selectButton.addEventListener("click", () => {
    if (!state.isProcessing && browserSupportsSecurePipeline()) {
      elements.fileInput.click();
    }
  });

  elements.fileInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    elements.fileInput.value = "";
    await stageIncomingFiles(files);
  });

  elements.convertButton.addEventListener("click", async () => {
    if (!browserSupportsSecurePipeline()) {
      setStatus("このブラウザでは安全要件を満たす変換処理を提供できません。", "danger");
      return;
    }

    if (state.isProcessing) {
      setStatus("現在処理中です。完了してから次の変換を開始してください。", "warn");
      return;
    }

    if (!state.pendingFiles.length) {
      setStatus("先に画像を選択してください。", "warn");
      return;
    }

    const filesToProcess = state.pendingFiles.slice();
    setPendingFiles([]);
    await processIncomingFiles(filesToProcess);
  });

  elements.clearButton.addEventListener("click", () => {
    if (state.isProcessing) {
      return;
    }
    setPendingFiles([]);
    clearResults();
    setStatus("選択中の画像と結果をクリアしました。新しい画像を選べます。", "success");
  });

  elements.qualityRange.addEventListener("input", updateQualityLabel);

  ["dragenter", "dragover"].forEach((eventName) => {
    elements.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (!browserSupportsSecurePipeline()) {
        return;
      }
      elements.dropzone.classList.add("is-dragover");
    });
  });

  ["dragleave", "dragend", "drop"].forEach((eventName) => {
    elements.dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropzone.classList.remove("is-dragover");
    });
  });

  elements.dropzone.addEventListener("drop", async (event) => {
    if (!browserSupportsSecurePipeline()) {
      return;
    }

    const files = Array.from(event.dataTransfer?.files || []);
    await stageIncomingFiles(files);
  });

  elements.dropzone.addEventListener("keydown", (event) => {
    if (event.target !== elements.dropzone || !browserSupportsSecurePipeline()) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.selectButton.click();
    }
  });

  window.addEventListener("beforeunload", () => {
    cleanupObjectUrls();
    teardownWorker();
  });
}

/**
 * 選択されたファイルを待機キューへ入れ、開始ボタンで実行できる状態にする。
 * この段階ではまだ変換せず、単一ファイルの対象だけを決めて UI へ反映する。
 *
 * @param {File[]} files ブラウザから渡された入力ファイル一覧
 * @returns {Promise<void>}
 */
async function stageIncomingFiles(files) {
  if (!browserSupportsSecurePipeline()) {
    setStatus("このブラウザでは安全要件を満たす変換処理を提供できません。", "danger");
    return;
  }

  if (!files.length) {
    setStatus("ファイルが選択されていません。画像を追加してください。", "warn");
    return;
  }

  if (state.isProcessing) {
    setStatus("現在処理中です。完了してから次の画像を追加してください。", "warn");
    return;
  }

  const selection = limitBatch(files);
  if (!selection.files.length) {
    setStatus("画像を 1 枚選択してください。", "warn");
    return;
  }

  const hadPendingFiles = state.pendingFiles.length > 0;
  const notices = [];
  const selectedFile = selection.files[0];

  if (selection.limitedByCount) {
    notices.push("複数ファイルが渡されたため、最初の 1 件だけを対象にしました。");
  }

  setPendingFiles(selection.files);

  const prefix = hadPendingFiles ? "前の選択を置き換えて、" : "";
  const baseMessage = `${prefix}「${selectedFile.name}」を対象ファイルとして選択しました。変換を開始してください。`;
  setStatus(notices.length ? `${baseMessage} ${notices.join(" ")}` : baseMessage, notices.length ? "warn" : "info");
}

/**
 * ユーザーが選んだファイルを順番に検査し、通過したものだけを JPG に変換する。
 * 途中で失敗したファイルがあっても、ほかのファイルの処理は続行する。
 *
 * @param {File[]} files ブラウザから渡された入力ファイル一覧
 * @returns {Promise<void>}
 */
async function processIncomingFiles(files) {
  if (!browserSupportsSecurePipeline()) {
    setStatus("このブラウザでは安全要件を満たす変換処理を提供できません。", "danger");
    return;
  }

  if (!files.length) {
    setStatus("ファイルが選択されていません。画像を追加してください。", "warn");
    return;
  }

  if (state.isProcessing) {
    setStatus("現在処理中です。完了してから次の画像を追加してください。", "warn");
    return;
  }

  const settings = getProcessingSettings();
  let processedThisRun = 0;
  let rejectedThisRun = 0;
  setBusy(true);

  try {
    for (const file of files) {
      const card = createResultCard(file.name);
      elements.resultsList.prepend(card.root);
      syncEmptyState();

      try {
        const inspection = await inspectFile(file);
        if (!inspection.ok) {
          renderRejectedCard(card, inspection.reason);
          state.summary.rejected += 1;
          rejectedThisRun += 1;
          updateSummary();
          continue;
        }

        renderProcessingCard(card, inspection.kind);
        await nextFrame();
        const output = await convertToJpeg(file, inspection, settings);
        renderSuccessCard(card, file, inspection, output);
        state.summary.processed += 1;
        processedThisRun += 1;
        state.summary.totalInputBytes += file.size;
        state.summary.totalOutputBytes += output.blob.size;
        updateSummary();
      } catch (error) {
        renderRejectedCard(card, formatProcessingError(error));
        state.summary.rejected += 1;
        rejectedThisRun += 1;
        updateSummary();
      }
    }
  } catch (error) {
    setStatus(`変換処理を完了できませんでした。${formatProcessingError(error)}`, "danger");
    return;
  } finally {
    setBusy(false);
  }

  updateCompletionStatus(processedThisRun, rejectedThisRun);
}

/**
 * 受け取った一覧から、今回の対象にする 1 ファイルだけを選び出す。
 *
 * @param {File[]} files ユーザーが渡した入力ファイル一覧
 * @returns {{files: File[], limitedByCount: boolean}}
 */
function limitBatch(files) {
  return {
    files: files.length ? [files[0]] : [],
    limitedByCount: files.length > MAX_FILES
  };
}

/**
 * 変換待ちのファイル一覧を state に保存し、開始ボタンの表示を更新する。
 *
 * @param {File[]} files 次に変換するファイル一覧
 */
function setPendingFiles(files) {
  state.pendingFiles = files.slice(0, MAX_FILES);
  updatePendingSelection();
}

/**
 * 現在の待機状態に合わせて、開始ボタンとドロップエリア表示を更新する。
 */
function updatePendingSelection() {
  const hasPendingFile = state.pendingFiles.length === 1;
  elements.selectButton.textContent = hasPendingFile ? "別の画像を選ぶ" : "画像を選ぶ";
  elements.convertButton.textContent = hasPendingFile ? "この画像を変換" : "変換を開始";
  elements.convertButton.disabled = state.isProcessing || !browserSupportsSecurePipeline() || !hasPendingFile;
  updateDropzoneSelection();
}

/**
 * ドロップエリア自体にも選択中のファイル名を反映し、
 * いま何が変換対象なのかをその場で分かるようにする。
 */
function updateDropzoneSelection() {
  const selectedFile = state.pendingFiles[0];

  if (!selectedFile) {
    elements.dropzone.dataset.state = "empty";
    elements.dropzoneStateBadge.textContent = "未選択";
    elements.dropzoneTitle.textContent = "画像をここにドロップ";
    elements.dropzoneSubtitle.textContent = "またはローカルファイルを選択してください";
    elements.dropzoneNote.textContent = "1 回につき 1 ファイルだけ変換します。";
    return;
  }

  const extension = getExtension(selectedFile.name);
  const extensionLabel = extension ? extension.toUpperCase() : "IMAGE";

  elements.dropzone.dataset.state = "selected";
  elements.dropzoneStateBadge.textContent = "選択済み";
  elements.dropzoneTitle.textContent = selectedFile.name;
  elements.dropzoneSubtitle.textContent = `${extensionLabel} ・ ${formatBytes(selectedFile.size)} ・ この画像が変換対象です。`;
  elements.dropzoneNote.textContent = "内容を確認したら「この画像を変換」を押してください。";
}

/**
 * 1回の実行結果に応じて、最後に表示するステータスメッセージを決める。
 *
 * @param {number} processedCount 今回成功した件数
 * @param {number} rejectedCount 今回拒否または失敗した件数
 */
function updateCompletionStatus(processedCount, rejectedCount) {
  if (processedCount > 0 && rejectedCount === 0) {
    setStatus("変換が完了しました。必要な JPG をダウンロードしてください。", "success");
    return;
  }

  if (processedCount > 0 && rejectedCount > 0) {
    setStatus(
      `${processedCount} 件を変換しました。${rejectedCount} 件は拒否またはエラーのため変換できませんでした。`,
      "warn"
    );
    return;
  }

  if (rejectedCount > 0) {
    setStatus("変換できる画像がありませんでした。すべて拒否またはエラーになりました。", "danger");
    return;
  }

  setStatus("変換対象がありませんでした。もう一度画像を選択してください。", "warn");
}

/**
 * 現在の UI 設定から変換オプションを組み立てる。
 *
 * @returns {{quality: number}}
 */
function getProcessingSettings() {
  return {
    quality: clamp(Number(elements.qualityRange.value) / 100, JPEG_QUALITY_MIN, 0.92)
  };
}

/**
 * 1ファイル単位の安全検査を行う。
 * サイズ、拡張子や MIME、マジックナンバー、画像寸法を確認し、
 * 変換に使ってよいデータだけを次の段階へ渡す。
 *
 * @param {File} file 検査対象のファイル
 * @returns {Promise<{ok: true, kind: string, sanitizedBlob: Blob | null, width: number, height: number} | {ok: false, reason: string}>}
 */
async function inspectFile(file) {
  if (file.size === 0) {
    return rejectInspection("空のファイルは処理できません。");
  }

  if (file.size > MAX_FILE_BYTES) {
    return rejectInspection(`1ファイル ${formatBytes(MAX_FILE_BYTES)} を超えるため拒否しました。`);
  }

  const extension = getExtension(file.name);
  const mimeLooksImage = typeof file.type === "string" && file.type.startsWith("image/");
  const extensionAllowed = ALLOWED_EXTENSIONS.has(extension);

  if (!mimeLooksImage && !extensionAllowed) {
    return rejectInspection("画像以外のファイルはアップロードできません。");
  }

  const header = await readHeaderBytes(file, MAX_HEADER_BYTES);
  const sniffed = await sniffImageKind(file, extension, header);
  if (!sniffed.ok) {
    return sniffed;
  }

  const validatedDimensions = validateDimensions(sniffed.width, sniffed.height);
  if (!validatedDimensions.ok) {
    return validatedDimensions;
  }

  return {
    ok: true,
    kind: sniffed.kind,
    sanitizedBlob: sniffed.sanitizedBlob || null,
    width: validatedDimensions.width,
    height: validatedDimensions.height
  };
}

/**
 * ファイル先頭のバイト列から実際の画像形式を判定する。
 * 拡張子だけに頼らず、中身が画像として妥当かを確認するための関数。
 *
 * @param {File} file 元ファイル
 * @param {string} extension ファイル名から取り出した拡張子
 * @param {Uint8Array} header 先頭ヘッダの生バイト列
 * @returns {Promise<{ok: true, kind: string, sanitizedBlob: Blob | null, width: number, height: number} | {ok: false, reason: string}>}
 */
async function sniffImageKind(file, extension, header) {
  if (isJpeg(header)) {
    const dimensions = extractJpegDimensions(header);
    return acceptInspection("jpeg", dimensions);
  }

  if (isPng(header)) {
    const dimensions = extractPngDimensions(header);
    return acceptInspection("png", dimensions);
  }

  if (isGif(header)) {
    const dimensions = extractGifDimensions(header);
    return acceptInspection("gif", dimensions);
  }

  if (isWebp(header)) {
    const dimensions = extractWebpDimensions(header);
    return acceptInspection("webp", dimensions);
  }

  if (isBmp(header)) {
    const dimensions = extractBmpDimensions(header);
    return acceptInspection("bmp", dimensions);
  }

  if (isIco(header)) {
    const dimensions = extractIcoDimensions(header);
    return acceptInspection("ico", dimensions);
  }

  if (isTiff(header)) {
    const dimensions = extractTiffDimensions(header);
    return acceptInspection("tiff", dimensions);
  }

  if (isIsoImage(header)) {
    const kind = detectIsoImageKind(header);
    const dimensions = extractIsoBmffDimensions(header);
    return acceptInspection(kind, dimensions);
  }

  if (looksLikeSvg(header) || extension === "svg") {
    const sanitized = await sanitizeSvg(file);
    return acceptInspection("svg", {
      sanitizedBlob: sanitized.blob,
      width: sanitized.width,
      height: sanitized.height
    });
  }

  return rejectInspection("画像のシグネチャを安全に確認できない形式は拒否しました。");
}

/**
 * SVG を安全に扱うための無害化処理。
 * スクリプト実行につながる要素や属性を取り除き、
 * 変換してよいサイズと複雑さかどうかも合わせて確認する。
 *
 * @param {File} file SVG ファイル
 * @returns {Promise<{blob: Blob, width: number, height: number}>}
 */
async function sanitizeSvg(file) {
  if (file.size > MAX_SVG_BYTES) {
    throw new Error(`SVG は ${formatBytes(MAX_SVG_BYTES)} までです。`);
  }

  const source = await file.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(source, "image/svg+xml");

  if (doc.querySelector("parsererror")) {
    throw new Error("SVG の解析に失敗しました。");
  }

  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") {
    throw new Error("SVG として解釈できませんでした。");
  }

  if (doc.querySelectorAll("*").length > MAX_SVG_ELEMENTS) {
    throw new Error("複雑すぎる SVG は安全のため拒否しました。");
  }

  const treeWalker = document.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
  const removals = [];

  while (treeWalker.nextNode()) {
    const node = treeWalker.currentNode;
    const tagName = node.tagName.toLowerCase();

    if (SVG_DANGEROUS_TAGS.has(tagName)) {
      removals.push(node);
      continue;
    }

    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      const lowerValue = value.toLowerCase();

      if (name.startsWith("on")) {
        node.removeAttribute(attribute.name);
        continue;
      }

      if (name === "href" || name === "xlink:href") {
        const isLocalReference = value.startsWith("#");
        const isSafeDataUri = /^data:image\/(png|jpeg|jpg|webp|gif|bmp|avif);/i.test(lowerValue);
        if (!isLocalReference && !isSafeDataUri) {
          node.removeAttribute(attribute.name);
          continue;
        }
      }

      if (
        name === "style" ||
        name === "href" ||
        name === "xlink:href" ||
        name === "filter" ||
        name === "mask" ||
        name === "clip-path"
      ) {
        if (/javascript:|url\s*\(|@import|expression\s*\(/i.test(lowerValue)) {
          node.removeAttribute(attribute.name);
        }
      }
    }
  }

  removals.forEach((node) => node.remove());

  const dimensions = extractSvgDimensions(root);
  const validatedDimensions = validateDimensions(dimensions.width, dimensions.height);
  if (!validatedDimensions.ok) {
    throw new Error(validatedDimensions.reason);
  }

  const serialized = new XMLSerializer().serializeToString(doc);
  return {
    blob: new Blob([serialized], { type: "image/svg+xml" }),
    width: validatedDimensions.width,
    height: validatedDimensions.height
  };
}

/**
 * 検査済みの画像データを Worker へ渡し、JPG へ変換した結果を受け取る。
 * SVG の場合は無害化済み Blob を使い、それ以外は元ファイルをそのまま渡す。
 *
 * @param {File} file 元ファイル
 * @param {{sanitizedBlob: Blob | null}} inspection 事前検査の結果
 * @param {{quality: number}} settings 変換品質の設定
 * @returns {Promise<{blob: Blob, previewUrl: string, originalPreviewUrl: string, outputWidth: number, outputHeight: number, quality: number}>}
 */
async function convertToJpeg(file, inspection, settings) {
  const sourceBlob = inspection.sanitizedBlob || file;
  const result = await convertInWorker(sourceBlob, {
    sourceBytes: file.size,
    quality: settings.quality,
    maxWidth: MAX_IMAGE_WIDTH,
    maxHeight: MAX_IMAGE_HEIGHT,
    maxPixels: MAX_IMAGE_PIXELS
  });

  return {
    blob: result.blob,
    previewUrl: trackObjectUrl(URL.createObjectURL(result.blob)),
    originalPreviewUrl: trackObjectUrl(URL.createObjectURL(sourceBlob)),
    outputWidth: result.width,
    outputHeight: result.height,
    quality: result.quality
  };
}

/**
 * 変換処理を UI スレッドから分離し、一定時間で終わらない処理は打ち切る。
 * 重い画像処理で画面が固まるのを防ぎつつ、暴走時には Worker ごと作り直す。
 *
 * @param {Blob} blob Worker に渡す入力データ
 * @param {{sourceBytes: number, quality: number, maxWidth: number, maxHeight: number, maxPixels: number}} payload Worker に渡す制限値
 * @returns {Promise<{blob: Blob, width: number, height: number, quality: number}>}
 */
function convertInWorker(blob, payload) {
  ensureWorker();

  return new Promise((resolve, reject) => {
    const jobId = state.nextJobId;
    state.nextJobId += 1;

    const timeoutId = window.setTimeout(() => {
      if (!state.pendingJobs.has(jobId)) {
        return;
      }

      state.pendingJobs.delete(jobId);
      teardownWorker();
      reject(new Error("変換処理が時間制限を超えたため中止しました。"));
    }, PROCESS_TIMEOUT_MS);

    state.pendingJobs.set(jobId, { resolve, reject, timeoutId });
    state.worker.postMessage({
      jobId,
      blob,
      ...payload
    });
  });
}

/**
 * Worker が未作成なら生成し、メッセージ受信処理を接続する。
 */
function ensureWorker() {
  if (state.worker) {
    return;
  }

  state.worker = new Worker("./assets/js/image-worker.js");
  state.worker.addEventListener("message", handleWorkerMessage);
  state.worker.addEventListener("error", handleWorkerError);
}

/**
 * Worker を停止し、待機中ジョブをすべて失敗として片付ける。
 */
function teardownWorker() {
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }

  state.pendingJobs.forEach((pending) => {
    window.clearTimeout(pending.timeoutId);
    pending.reject(new Error("変換ワーカーを再起動しました。もう一度試してください。"));
  });
  state.pendingJobs.clear();
}

/**
 * Worker から返ってきた結果を、対応する待機中ジョブへ受け渡す。
 *
 * @param {MessageEvent} event Worker からの応答イベント
 */
function handleWorkerMessage(event) {
  const { jobId, ok, error, blob, width, height, quality } = event.data || {};
  const pending = state.pendingJobs.get(jobId);
  if (!pending) {
    return;
  }

  window.clearTimeout(pending.timeoutId);
  state.pendingJobs.delete(jobId);

  if (!ok) {
    pending.reject(new Error(error || "変換処理に失敗しました。"));
    return;
  }

  pending.resolve({ blob, width, height, quality });
}

/**
 * Worker 側で想定外エラーが起きたときに、Worker を安全に作り直せる状態へ戻す。
 */
function handleWorkerError() {
  teardownWorker();
}

/**
 * 1ファイル分の結果表示カードを組み立て、参照しやすい要素群を返す。
 *
 * @param {string} filename 表示用の元ファイル名
 * @returns {{root: HTMLElement, badge: HTMLElement, message: HTMLElement, stats: HTMLElement, actions: HTMLElement, originalImage: HTMLImageElement, resultImage: HTMLImageElement}}
 */
function createResultCard(filename) {
  const root = document.createElement("article");
  root.className = "result-card";
  root.dataset.state = "processing";

  const header = document.createElement("div");
  header.className = "result-card-header";

  const title = document.createElement("p");
  title.className = "result-card-title";
  title.textContent = filename;

  const badge = document.createElement("span");
  badge.className = "result-badge";
  badge.textContent = "検査中";

  header.append(title, badge);

  const message = document.createElement("p");
  message.className = "result-message";
  message.textContent = "ファイル形式と寸法を確認しています。";

  const previewGrid = document.createElement("div");
  previewGrid.className = "result-preview-grid";

  const originalPanel = createPreviewPanel("Original");
  const resultPanel = createPreviewPanel("JPG");
  previewGrid.append(originalPanel.root, resultPanel.root);

  const stats = document.createElement("div");
  stats.className = "result-stats";

  const actions = document.createElement("div");
  actions.className = "result-actions";

  root.append(header, message, previewGrid, stats, actions);

  return {
    root,
    badge,
    message,
    stats,
    actions,
    originalImage: originalPanel.image,
    resultImage: resultPanel.image
  };
}

/**
 * 画像プレビュー用の小さな表示枠を生成する。
 *
 * @param {string} label パネルの見出し
 * @returns {{root: HTMLElement, image: HTMLImageElement}}
 */
function createPreviewPanel(label) {
  const root = document.createElement("div");
  root.className = "preview-panel";

  const title = document.createElement("span");
  title.textContent = label;

  const image = document.createElement("img");
  image.alt = `${label} preview`;

  root.append(title, image);
  return { root, image };
}

/**
 * カードを「変換中」表示へ切り替える。
 *
 * @param {{root: HTMLElement, badge: HTMLElement, message: HTMLElement}} card 更新対象のカード
 * @param {string} kind 入力画像の形式名
 */
function renderProcessingCard(card, kind) {
  card.root.dataset.state = "processing";
  card.badge.textContent = "変換中";
  card.badge.removeAttribute("data-tone");
  card.message.textContent = `${humanizeKind(kind)} を圧縮し、隔離ワーカー内で JPG に変換しています。`;
}

/**
 * カードを「拒否または失敗」表示へ切り替える。
 *
 * @param {{root: HTMLElement, badge: HTMLElement, message: HTMLElement, stats: HTMLElement, actions: HTMLElement, originalImage: HTMLImageElement, resultImage: HTMLImageElement}} card 更新対象のカード
 * @param {string} reason 表示する理由メッセージ
 */
function renderRejectedCard(card, reason) {
  card.root.dataset.state = "error";
  card.badge.textContent = "拒否 / エラー";
  card.badge.dataset.tone = "danger";
  card.message.textContent = reason;
  card.stats.replaceChildren(makeStat("状態", "処理できませんでした"));
  card.actions.replaceChildren();
  card.originalImage.removeAttribute("src");
  card.resultImage.removeAttribute("src");
}

/**
 * 変換成功時のプレビュー、統計、ダウンロード操作をカードへ反映する。
 *
 * @param {{root: HTMLElement, badge: HTMLElement, message: HTMLElement, stats: HTMLElement, actions: HTMLElement, originalImage: HTMLImageElement, resultImage: HTMLImageElement}} card 更新対象のカード
 * @param {File} inputFile 元ファイル
 * @param {{width: number, height: number}} inspection 検査時に得た入力画像情報
 * @param {{blob: Blob, previewUrl: string, originalPreviewUrl: string, outputWidth: number, outputHeight: number, quality: number}} output 変換結果
 */
function renderSuccessCard(card, inputFile, inspection, output) {
  const ratio = Math.max(0, 1 - output.blob.size / inputFile.size);

  card.root.dataset.state = "success";
  card.badge.textContent = "変換完了";
  card.badge.dataset.tone = "success";
  card.message.textContent =
    ratio > 0
      ? `圧縮後に JPG へ変換しました。${Math.round(ratio * 100)}% 削減しています。`
      : "JPG へ変換しました。元画像より大きくなるため画質と互換性を優先しています。";
  card.originalImage.src = output.originalPreviewUrl;
  card.resultImage.src = output.previewUrl;

  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.className = "download-button";
  downloadButton.textContent = "JPG をダウンロード";
  downloadButton.addEventListener("click", () => {
    const link = document.createElement("a");
    link.href = output.previewUrl;
    link.download = createDownloadName(inputFile.name);
    link.rel = "noopener noreferrer";
    link.click();
  });

  card.stats.replaceChildren(
    makeStat("入力サイズ", formatBytes(inputFile.size)),
    makeStat("出力サイズ", formatBytes(output.blob.size)),
    makeStat("入力解像度", `${inspection.width} × ${inspection.height}`),
    makeStat("出力解像度", `${output.outputWidth} × ${output.outputHeight}`),
    makeStat("JPG 品質", `${Math.round(output.quality * 100)}%`)
  );
  card.actions.replaceChildren(downloadButton);
}

/**
 * ラベルと値から、結果カードに表示する統計行を作る。
 *
 * @param {string} label 項目名
 * @param {string} value 表示値
 * @returns {HTMLParagraphElement}
 */
function makeStat(label, value) {
  const block = document.createElement("p");
  block.textContent = `${label}: ${value}`;
  return block;
}

/**
 * UI 全体を処理中 / 待機中の状態へ切り替える。
 *
 * @param {boolean} isBusy 現在処理中なら true
 */
function setBusy(isBusy) {
  state.isProcessing = isBusy;
  elements.dropzone.classList.toggle("is-busy", isBusy);
  elements.dropzone.setAttribute("aria-busy", String(isBusy));
  setInteractiveEnabled(!isBusy);
  updatePendingSelection();
}

/**
 * 入力操作に関わる UI 要素をまとめて有効化または無効化する。
 *
 * @param {boolean} enabled 操作を許可するなら true
 */
function setInteractiveEnabled(enabled) {
  elements.fileInput.disabled = !enabled;
  elements.selectButton.disabled = !enabled;
  elements.clearButton.disabled = !enabled;
  elements.qualityRange.disabled = !enabled;

  if (!enabled) {
    elements.convertButton.disabled = true;
    return;
  }

  updatePendingSelection();
}

/**
 * 表示中の結果と集計をすべて初期状態へ戻す。
 */
function clearResults() {
  cleanupObjectUrls();
  state.summary = {
    processed: 0,
    rejected: 0,
    totalInputBytes: 0,
    totalOutputBytes: 0
  };
  elements.resultsList.replaceChildren();
  elements.resultsList.append(elements.emptyState);
  syncEmptyState();
  updateSummary();
}

/**
 * 生成済みの Object URL をすべて解放し、メモリ使用量を抑える。
 */
function cleanupObjectUrls() {
  state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
  state.objectUrls.clear();
}

/**
 * 新しく作った Object URL を追跡対象へ登録し、そのまま返す。
 *
 * @param {string} url 追跡する Object URL
 * @returns {string}
 */
function trackObjectUrl(url) {
  state.objectUrls.add(url);
  return url;
}

/**
 * 結果カードの有無に応じて、空状態メッセージの表示を切り替える。
 */
function syncEmptyState() {
  const hasCards = Array.from(elements.resultsList.children).some((child) => child !== elements.emptyState);
  elements.emptyState.hidden = hasCards;
}

/**
 * 累計の成功件数、失敗件数、削減サイズ、平均圧縮率を再計算して表示する。
 */
function updateSummary() {
  const savedBytes = Math.max(0, state.summary.totalInputBytes - state.summary.totalOutputBytes);
  const averageRatio =
    state.summary.totalInputBytes > 0
      ? Math.max(0, 1 - state.summary.totalOutputBytes / state.summary.totalInputBytes)
      : 0;

  elements.processedCount.textContent = String(state.summary.processed);
  elements.rejectedCount.textContent = String(state.summary.rejected);
  elements.savedSize.textContent = formatBytes(savedBytes);
  elements.averageRatio.textContent = `${Math.round(averageRatio * 100)}%`;
}

/**
 * スライダー値を画面上の品質表示へ反映する。
 */
function updateQualityLabel() {
  const value = Number(elements.qualityRange.value);
  elements.qualityValue.textContent = `${value}%`;
}

/**
 * ステータスメッセージ本文と見た目の種別を更新する。
 *
 * @param {string} message 表示するメッセージ
 * @param {string} tone 見た目に使うトーン名
 */
function setStatus(message, tone) {
  elements.statusMessage.textContent = message;
  elements.statusMessage.dataset.tone = tone;
}

/**
 * 画像寸法がアプリの安全上限に収まっているかを確認する。
 * サイズが極端に大きい画像や、総画素数が多すぎる画像をここで拒否する。
 *
 * @param {number} width 画像の横幅
 * @param {number} height 画像の高さ
 * @returns {{ok: true, width: number, height: number} | {ok: false, reason: string}}
 */
function validateDimensions(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return rejectInspection("画像の解像度を安全に判定できませんでした。");
  }

  if (width > MAX_IMAGE_WIDTH || height > MAX_IMAGE_HEIGHT) {
    return rejectInspection(`画像の縦横は ${MAX_IMAGE_WIDTH}px × ${MAX_IMAGE_HEIGHT}px 以内にしてください。`);
  }

  if (width * height > MAX_IMAGE_PIXELS) {
    return rejectInspection(`画像の総画素数は ${MAX_IMAGE_PIXELS.toLocaleString("ja-JP")} ピクセル以内にしてください。`);
  }

  return { ok: true, width: Math.round(width), height: Math.round(height) };
}

/**
 * 安全な変換パイプラインに必要なブラウザ機能が揃っているか判定する。
 *
 * @returns {boolean}
 */
function browserSupportsSecurePipeline() {
  return typeof Worker === "function" && typeof window.createImageBitmap === "function" && typeof window.OffscreenCanvas === "function";
}

/**
 * ファイル先頭の一定量だけを読み込み、形式判定に使う生バイト列へ変換する。
 *
 * @param {File} file 読み込むファイル
 * @param {number} limit 最大読込バイト数
 * @returns {Promise<Uint8Array>}
 */
function readHeaderBytes(file, limit) {
  return file.slice(0, Math.min(limit, file.size)).arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

/**
 * JPEG のシグネチャかどうかを判定する。
 *
 * @param {Uint8Array} bytes 先頭バイト列
 * @returns {boolean}
 */
function isJpeg(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * PNG のシグネチャかどうかを判定する。
 *
 * @param {Uint8Array} bytes 先頭バイト列
 * @returns {boolean}
 */
function isPng(bytes) {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

/**
 * GIF のシグネチャかどうかを判定する。
 *
 * @param {Uint8Array} bytes 先頭バイト列
 * @returns {boolean}
 */
function isGif(bytes) {
  return (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  );
}

/**
 * WebP の RIFF ヘッダかどうかを判定する。
 *
 * @param {Uint8Array} bytes 先頭バイト列
 * @returns {boolean}
 */
function isWebp(bytes) {
  return bytes.length >= 12 && readAscii(bytes, 0, 4) === "RIFF" && readAscii(bytes, 8, 4) === "WEBP";
}

/**
 * BMP のシグネチャかどうかを判定する。
 *
 * @param {Uint8Array} bytes 先頭バイト列
 * @returns {boolean}
 */
function isBmp(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d;
}

/**
 * ICO のシグネチャかどうかを判定する。
 *
 * @param {Uint8Array} bytes 先頭バイト列
 * @returns {boolean}
 */
function isIco(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00;
}

/**
 * TIFF のエンディアン付きシグネチャかどうかを判定する。
 *
 * @param {Uint8Array} bytes 先頭バイト列
 * @returns {boolean}
 */
function isTiff(bytes) {
  return (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
  );
}

/**
 * AVIF / HEIC 系で使われる ISO BMFF 形式かどうかを判定する。
 *
 * @param {Uint8Array} bytes 先頭バイト列
 * @returns {boolean}
 */
function isIsoImage(bytes) {
  return bytes.length >= 12 && readAscii(bytes, 4, 4) === "ftyp" && IMAGE_BRANDS.has(readAscii(bytes, 8, 4).toLowerCase());
}

/**
 * ISO BMFF のブランド文字列から AVIF か HEIC かを大まかに決める。
 *
 * @param {Uint8Array} bytes ヘッダのバイト列
 * @returns {string}
 */
function detectIsoImageKind(bytes) {
  const brand = readAscii(bytes, 8, 4).toLowerCase();
  return brand.startsWith("av") ? "avif" : "heic";
}

/**
 * テキストとして見たときに SVG に見える内容かを判定する。
 *
 * @param {Uint8Array} bytes 先頭バイト列
 * @returns {boolean}
 */
function looksLikeSvg(bytes) {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "").trimStart().toLowerCase();
  return text.startsWith("<svg") || text.includes("<svg");
}

/**
 * PNG ヘッダから画像寸法を取り出す。
 *
 * @param {Uint8Array} bytes PNG のバイト列
 * @returns {{width: number, height: number}}
 */
function extractPngDimensions(bytes) {
  if (bytes.length < 24) {
    throw new Error("PNG の寸法を確認できませんでした。");
  }

  const view = toDataView(bytes);
  return {
    width: view.getUint32(16, false),
    height: view.getUint32(20, false)
  };
}

/**
 * GIF ヘッダから画像寸法を取り出す。
 *
 * @param {Uint8Array} bytes GIF のバイト列
 * @returns {{width: number, height: number}}
 */
function extractGifDimensions(bytes) {
  if (bytes.length < 10) {
    throw new Error("GIF の寸法を確認できませんでした。");
  }

  const view = toDataView(bytes);
  return {
    width: view.getUint16(6, true),
    height: view.getUint16(8, true)
  };
}

/**
 * BMP ヘッダから画像寸法を取り出す。
 *
 * @param {Uint8Array} bytes BMP のバイト列
 * @returns {{width: number, height: number}}
 */
function extractBmpDimensions(bytes) {
  if (bytes.length < 26) {
    throw new Error("BMP の寸法を確認できませんでした。");
  }

  const view = toDataView(bytes);
  const dibSize = view.getUint32(14, true);

  if (dibSize === 12 && bytes.length >= 26) {
    return {
      width: view.getUint16(18, true),
      height: view.getUint16(20, true)
    };
  }

  if (dibSize >= 40 && bytes.length >= 26) {
    return {
      width: Math.abs(view.getInt32(18, true)),
      height: Math.abs(view.getInt32(22, true))
    };
  }

  throw new Error("BMP のヘッダ形式に対応していません。");
}

/**
 * ICO ヘッダから画像寸法を取り出す。
 *
 * @param {Uint8Array} bytes ICO のバイト列
 * @returns {{width: number, height: number}}
 */
function extractIcoDimensions(bytes) {
  if (bytes.length < 8) {
    throw new Error("ICO の寸法を確認できませんでした。");
  }

  return {
    width: bytes[6] || 256,
    height: bytes[7] || 256
  };
}

/**
 * TIFF の IFD をたどって画像寸法を取り出す。
 *
 * @param {Uint8Array} bytes TIFF のバイト列
 * @returns {{width: number, height: number}}
 */
function extractTiffDimensions(bytes) {
  const littleEndian = bytes[0] === 0x49;
  const view = toDataView(bytes);
  const firstIfdOffset = view.getUint32(4, littleEndian);

  if (firstIfdOffset <= 0 || firstIfdOffset + 2 > bytes.length) {
    throw new Error("TIFF の寸法を確認できませんでした。");
  }

  const entryCount = view.getUint16(firstIfdOffset, littleEndian);
  let width = 0;
  let height = 0;

  for (let index = 0; index < entryCount; index += 1) {
    const offset = firstIfdOffset + 2 + index * 12;
    if (offset + 12 > bytes.length) {
      break;
    }

    const tag = view.getUint16(offset, littleEndian);
    const type = view.getUint16(offset + 2, littleEndian);
    const count = view.getUint32(offset + 4, littleEndian);

    if (count < 1) {
      continue;
    }

    let value = 0;
    if (type === 3) {
      value = view.getUint16(offset + 8, littleEndian);
    } else if (type === 4) {
      value = view.getUint32(offset + 8, littleEndian);
    } else {
      continue;
    }

    if (tag === 256) {
      width = value;
    } else if (tag === 257) {
      height = value;
    }
  }

  if (!width || !height) {
    throw new Error("TIFF の寸法を確認できませんでした。");
  }

  return { width, height };
}

/**
 * ISO BMFF 内の `ispe` ボックスを探して画像寸法を取り出す。
 *
 * @param {Uint8Array} bytes AVIF / HEIC 系のバイト列
 * @returns {{width: number, height: number}}
 */
function extractIsoBmffDimensions(bytes) {
  for (let index = 0; index <= bytes.length - 16; index += 1) {
    if (readAscii(bytes, index, 4) !== "ispe") {
      continue;
    }

    const view = toDataView(bytes);
    const width = view.getUint32(index + 8, false);
    const height = view.getUint32(index + 12, false);

    if (width > 0 && height > 0) {
      return { width, height };
    }
  }

  throw new Error("AVIF / HEIC の寸法を安全に確認できませんでした。");
}

/**
 * JPEG の SOF セグメントを探して画像寸法を取り出す。
 *
 * @param {Uint8Array} bytes JPEG のバイト列
 * @returns {{width: number, height: number}}
 */
function extractJpegDimensions(bytes) {
  let offset = 2;

  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    let markerOffset = offset + 1;
    while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) {
      markerOffset += 1;
    }

    if (markerOffset >= bytes.length) {
      break;
    }

    const marker = bytes[markerOffset];
    offset = markerOffset + 1;

    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }

    if (offset + 2 > bytes.length) {
      break;
    }

    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      break;
    }

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (offset + 7 >= bytes.length) {
        break;
      }

      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6]
      };
    }

    offset += segmentLength;
  }

  throw new Error("JPEG の寸法を安全に確認できませんでした。");
}

/**
 * WebP のチャンク形式ごとに画像寸法を取り出す。
 *
 * @param {Uint8Array} bytes WebP のバイト列
 * @returns {{width: number, height: number}}
 */
function extractWebpDimensions(bytes) {
  if (bytes.length < 30) {
    throw new Error("WebP の寸法を確認できませんでした。");
  }

  const view = toDataView(bytes);
  const chunkType = readAscii(bytes, 12, 4);

  if (chunkType === "VP8X") {
    return {
      width: 1 + readUint24LE(bytes, 24),
      height: 1 + readUint24LE(bytes, 27)
    };
  }

  if (chunkType === "VP8 ") {
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff
    };
  }

  if (chunkType === "VP8L") {
    const b0 = bytes[21];
    const b1 = bytes[22];
    const b2 = bytes[23];
    const b3 = bytes[24];

    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
    };
  }

  throw new Error("WebP の寸法を確認できませんでした。");
}

/**
 * SVG 要素の属性から表示寸法を導出する。
 *
 * @param {Element} root SVG のルート要素
 * @returns {{width: number, height: number}}
 */
function extractSvgDimensions(root) {
  const widthAttr = parseSvgLength(root.getAttribute("width"));
  const heightAttr = parseSvgLength(root.getAttribute("height"));
  const viewBox = parseSvgViewBox(root.getAttribute("viewBox"));

  if (widthAttr && heightAttr) {
    return { width: widthAttr, height: heightAttr };
  }

  if (viewBox && widthAttr) {
    return { width: widthAttr, height: widthAttr * (viewBox.height / viewBox.width) };
  }

  if (viewBox && heightAttr) {
    return { width: heightAttr * (viewBox.width / viewBox.height), height: heightAttr };
  }

  if (viewBox) {
    return { width: viewBox.width, height: viewBox.height };
  }

  throw new Error("SVG の width / height または viewBox が必要です。");
}

/**
 * SVG の長さ指定をピクセル相当の数値へ変換する。
 *
 * @param {string | null} value SVG の長さ文字列
 * @returns {number | null}
 */
function parseSvgLength(value) {
  if (!value) {
    return null;
  }

  const match = value.trim().match(/^([+-]?\d*\.?\d+)(px|pt|pc|mm|cm|in)?$/i);
  if (!match) {
    return null;
  }

  const amount = Number.parseFloat(match[1]);
  const unit = (match[2] || "px").toLowerCase();

  switch (unit) {
    case "px":
      return amount;
    case "pt":
      return amount * (96 / 72);
    case "pc":
      return amount * 16;
    case "mm":
      return amount * (96 / 25.4);
    case "cm":
      return amount * (96 / 2.54);
    case "in":
      return amount * 96;
    default:
      return null;
  }
}

/**
 * SVG の viewBox 文字列を数値オブジェクトへ分解する。
 *
 * @param {string | null} value viewBox 属性値
 * @returns {{width: number, height: number} | null}
 */
function parseSvgViewBox(value) {
  if (!value) {
    return null;
  }

  const parts = value
    .trim()
    .split(/[\s,]+/)
    .map((item) => Number.parseFloat(item))
    .filter((item) => Number.isFinite(item));

  if (parts.length !== 4 || parts[2] <= 0 || parts[3] <= 0) {
    return null;
  }

  return {
    width: parts[2],
    height: parts[3]
  };
}

/**
 * ファイル名から拡張子だけを小文字で取り出す。
 *
 * @param {string} filename 対象ファイル名
 * @returns {string}
 */
function getExtension(filename) {
  const parts = filename.toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() : "";
}

/**
 * バイト数を人に読みやすい単位付き文字列へ整形する。
 *
 * @param {number} bytes バイト数
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unit = units[0];

  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }

  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
}

/**
 * 元ファイル名から、安全にダウンロードできる JPG 名を作る。
 * 記号や長すぎる名前を整形し、パス操作に使われそうな文字を残さない。
 *
 * @param {string} originalName ユーザーが選んだ元ファイル名
 * @returns {string}
 */
function createDownloadName(originalName) {
  const base = originalName.replace(/\.[^.]+$/, "");
  const normalized = base.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const safeBase = normalized.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "image";
  return `${safeBase}-compressed.jpg`;
}

/**
 * 内部的な形式名を画面表示向けのラベルへ変換する。
 *
 * @param {string} kind 内部形式名
 * @returns {string}
 */
function humanizeKind(kind) {
  switch (kind) {
    case "jpeg":
      return "JPEG";
    case "png":
      return "PNG";
    case "gif":
      return "GIF";
    case "webp":
      return "WebP";
    case "bmp":
      return "BMP";
    case "ico":
      return "ICO";
    case "tiff":
      return "TIFF";
    case "avif":
      return "AVIF";
    case "heic":
      return "HEIC / HEIF";
    case "svg":
      return "SVG";
    default:
      return kind.toUpperCase();
  }
}

/**
 * 安全検査の成功結果を一定の形へそろえて返す。
 *
 * @param {string} kind 判定した画像形式
 * @param {{sanitizedBlob?: Blob | null, width?: number, height?: number} | undefined} details 追加情報
 * @returns {{ok: true, kind: string, sanitizedBlob: Blob | null, width: number | undefined, height: number | undefined}}
 */
function acceptInspection(kind, details) {
  return {
    ok: true,
    kind,
    sanitizedBlob: details?.sanitizedBlob || null,
    width: details?.width,
    height: details?.height
  };
}

/**
 * 安全検査の失敗結果を一定の形へそろえて返す。
 *
 * @param {string} reason 拒否理由
 * @returns {{ok: false, reason: string}}
 */
function rejectInspection(reason) {
  return { ok: false, reason };
}

/**
 * 捕捉した例外を、画面表示に使える短いメッセージへ整える。
 *
 * @param {unknown} error 捕捉した例外
 * @returns {string}
 */
function formatProcessingError(error) {
  return error instanceof Error ? error.message : "変換中にエラーが発生しました。";
}

/**
 * バイト列を DataView として扱えるよう包み直す。
 *
 * @param {Uint8Array} bytes 対象バイト列
 * @returns {DataView}
 */
function toDataView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * 指定範囲のバイト列を ASCII 文字列として読む。
 *
 * @param {Uint8Array} bytes 元バイト列
 * @param {number} start 読み始め位置
 * @param {number} length 読み出す長さ
 * @returns {string}
 */
function readAscii(bytes, start, length) {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

/**
 * 3バイトのリトルエンディアン整数を読む。
 *
 * @param {Uint8Array} bytes 元バイト列
 * @param {number} start 読み始め位置
 * @returns {number}
 */
function readUint24LE(bytes, start) {
  return bytes[start] | (bytes[start + 1] << 8) | (bytes[start + 2] << 16);
}

/**
 * 数値を最小値と最大値の範囲に収める。
 *
 * @param {number} value 対象値
 * @param {number} min 最小値
 * @param {number} max 最大値
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 次の描画フレームまで待ち、UI 更新を一度ブラウザへ反映させる。
 *
 * @returns {Promise<void>}
 */
function nextFrame() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}
