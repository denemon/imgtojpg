"use strict";

/**
 * 変換専用の Web Worker。
 * UI スレッドとは別で画像をデコードし、サイズ上限を再確認してから JPG を生成する。
 */
self.addEventListener("message", async (event) => {
  const { jobId, blob, sourceBytes, quality, maxWidth, maxHeight, maxPixels } = event.data || {};

  try {
    if (typeof self.OffscreenCanvas !== "function" || typeof self.createImageBitmap !== "function") {
      throw new Error("このブラウザは安全な変換ワーカーに未対応です。");
    }

    const bitmap = await self.createImageBitmap(blob, { imageOrientation: "from-image" });

    try {
      if (bitmap.width > maxWidth || bitmap.height > maxHeight || bitmap.width * bitmap.height > maxPixels) {
        throw new Error("画像の解像度が上限を超えたため中止しました。");
      }

      const canvas = progressiveScaleToCanvas(bitmap, bitmap.width, bitmap.height, bitmap.width, bitmap.height);
      const encoded = await encodeAdaptiveJpeg(canvas, sourceBytes, quality);

      self.postMessage({
        jobId,
        ok: true,
        blob: encoded.blob,
        width: encoded.width,
        height: encoded.height,
        quality: encoded.quality
      });
    } finally {
      bitmap.close();
    }
  } catch (error) {
    self.postMessage({
      jobId,
      ok: false,
      error: error instanceof Error ? error.message : "変換ワーカーでエラーが発生しました。"
    });
  }
});

/**
 * 描画元のビットマップを Canvas に移し替える。
 * 現在は等倍変換が中心だが、将来の縮小処理にも使い回せるよう段階的な経路にしている。
 *
 * @param {ImageBitmap | OffscreenCanvas} source 描画元の画像
 * @param {number} sourceWidth 元の横幅
 * @param {number} sourceHeight 元の高さ
 * @param {number} targetWidth 出力したい横幅
 * @param {number} targetHeight 出力したい高さ
 * @returns {OffscreenCanvas}
 */
function progressiveScaleToCanvas(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  let currentCanvas = createCanvas(sourceWidth, sourceHeight);
  let currentWidth = sourceWidth;
  let currentHeight = sourceHeight;

  drawToCanvas(currentCanvas, source, sourceWidth, sourceHeight);

  while (currentWidth * 0.5 > targetWidth || currentHeight * 0.5 > targetHeight) {
    const nextWidth = Math.max(targetWidth, Math.round(currentWidth * 0.5));
    const nextHeight = Math.max(targetHeight, Math.round(currentHeight * 0.5));
    currentCanvas = resampleCanvas(currentCanvas, nextWidth, nextHeight);
    currentWidth = nextWidth;
    currentHeight = nextHeight;
  }

  if (currentWidth !== targetWidth || currentHeight !== targetHeight) {
    currentCanvas = resampleCanvas(currentCanvas, targetWidth, targetHeight);
  }

  return currentCanvas;
}

/**
 * 既存 Canvas の内容を別サイズの Canvas へ描き直す。
 *
 * @param {OffscreenCanvas} sourceCanvas 元の Canvas
 * @param {number} width 出力する横幅
 * @param {number} height 出力する高さ
 * @returns {OffscreenCanvas}
 */
function resampleCanvas(sourceCanvas, width, height) {
  const canvas = createCanvas(width, height);
  drawToCanvas(canvas, sourceCanvas, width, height);
  return canvas;
}

/**
 * 指定サイズの OffscreenCanvas を生成する。
 *
 * @param {number} width 横幅
 * @param {number} height 高さ
 * @returns {OffscreenCanvas}
 */
function createCanvas(width, height) {
  return new OffscreenCanvas(width, height);
}

/**
 * 画像や Canvas を指定サイズで描画し、背景を白で塗りつぶす。
 *
 * @param {OffscreenCanvas} canvas 描画先 Canvas
 * @param {ImageBitmap | OffscreenCanvas} source 描画元
 * @param {number} width 描画幅
 * @param {number} height 描画高さ
 * @returns {void}
 */
function drawToCanvas(canvas, source, width, height) {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("描画コンテキストの初期化に失敗しました。");
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);
}

/**
 * Canvas を何段階かの画質で JPEG 化し、元ファイルより十分小さくなった時点で確定する。
 * 期待したサイズまで下がらない場合でも、その時点で最も小さい結果を返す。
 *
 * @param {OffscreenCanvas} canvas 変換元の Canvas
 * @param {number} sourceBytes 元ファイルのバイト数
 * @param {number} startingQuality 最初に試す JPEG 品質
 * @returns {Promise<{blob: Blob, quality: number, width: number, height: number}>}
 */
async function encodeAdaptiveJpeg(canvas, sourceBytes, startingQuality) {
  let workingCanvas = canvas;
  let best = null;
  const attemptedQualities = [startingQuality, 0.82, 0.74, 0.66, 0.58, 0.5, 0.42]
    .map((item) => clamp(item, 0.42, 0.92))
    .filter((item, index, array) => array.indexOf(item) === index)
    .sort((left, right) => right - left);

  for (let scaleAttempt = 0; scaleAttempt < 4; scaleAttempt += 1) {
    for (const candidateQuality of attemptedQualities) {
      const blob = await workingCanvas.convertToBlob({
        type: "image/jpeg",
        quality: candidateQuality
      });

      if (!best || blob.size < best.blob.size) {
        best = {
          blob,
          quality: candidateQuality,
          width: workingCanvas.width,
          height: workingCanvas.height
        };
      }

      if (blob.size <= Math.max(sourceBytes * 0.95, sourceBytes - 8192)) {
        return {
          blob,
          quality: candidateQuality,
          width: workingCanvas.width,
          height: workingCanvas.height
        };
      }
    }

    if (workingCanvas.width <= 960 || workingCanvas.height <= 960) {
      break;
    }

    workingCanvas = resampleCanvas(
      workingCanvas,
      Math.max(1, Math.round(workingCanvas.width * 0.9)),
      Math.max(1, Math.round(workingCanvas.height * 0.9))
    );
  }

  if (!best) {
    throw new Error("JPG の生成に失敗しました。");
  }

  return best;
}

/**
 * 数値を指定範囲へ収める。
 *
 * @param {number} value 対象値
 * @param {number} min 最小値
 * @param {number} max 最大値
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
