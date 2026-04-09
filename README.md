# imgtojpg

A lightweight browser-based image converter that compresses a single image and exports it as JPG.

Live page: [https://denemon.github.io/imgtojpg/](https://denemon.github.io/imgtojpg/)

## Overview

`imgtojpg` is a static web app designed to run entirely in the browser.
It lets users select one image file, review the selected target file, and convert it to JPG without uploading the image to a server.

## Features

- Converts one image at a time
- Runs fully client-side
- No server upload
- Drag and drop or file picker support
- In-browser compression before JPG export
- SVG sanitization before conversion
- File signature checks instead of relying only on extensions
- Size, dimension, and timeout limits for safer processing

## Supported Input Formats

- AVIF
- BMP
- GIF
- HEIC / HEIF
- ICO
- JFIF
- JPEG / JPG
- PNG
- SVG
- TIFF
- WebP

## How To Use

1. Open the live page.
2. Drag and drop one image, or choose a file from the picker.
3. Confirm the file shown in the "Target File" area.
4. Click `Convert`.
5. Download the generated JPG.

## Local Development

This project is a plain static site.
Run it with a local static server during development.

Example:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

## Browser Requirements

The app expects modern browser features such as:

- `Worker`
- `createImageBitmap`
- `OffscreenCanvas`

If these features are not available, the app disables conversion for safety.

## Security Notes

- Images are processed in the browser and are not sent to external servers.
- File headers are inspected to verify that inputs look like real image files.
- SVG files are sanitized before use.
- File size, pixel count, and processing time are limited.
- Conversion runs inside a worker to keep heavy processing away from the main UI thread.

## Project Structure

- `index.html`: page markup
- `assets/css/styles.css`: visual styling
- `assets/js/app.js`: UI logic, validation, and conversion flow
- `assets/js/image-worker.js`: worker-side image conversion
- `assets/images/og/compressed-banner.png`: social sharing image
- `assets/images/icons/compression-concept.png`: favicon source image

## Deployment

The site is suitable for static hosting, including GitHub Pages.

## License

No license file is included in this repository yet.
