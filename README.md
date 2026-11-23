# Root segmentation benchmark

A static, client-side proof of concept for the MobileSAM Root Foundation Model.
Runs the same FP32 ONNX graph with **WebGPU** or **CPU / WebAssembly**. No server
inference, accounts, API keys, CDN scripts or image uploads.

## Run locally

Requires Node.js 24 and npm.

```bash
npm ci --ignore-scripts
npm run dev
```

Open the printed local URL (normally `http://localhost:5173/`). Use HTTP on
localhost or HTTPS when hosted; opening `index.html` directly will not work.
`npm run build` creates a self-contained `dist/` directory containing runtime
binaries, the verified model, and the eight supplied test images. The linked
sibling project is not required to build or run the app.

## Use

1. Select WebGPU or CPU. WebGPU is disabled when no adapter is detected.
2. Choose or drop multiple images, or add the eight bundled test photos.
3. Process the batch. The table shows each image's dimensions, status, tile
   count, processing time, and mean tile time. Cancel stops the worker
   immediately and keeps already completed results.
4. After processing, view one result as original, overlay, or binary mask.
   Download full-resolution masks individually or together with **Download all
   masks (ZIP)**, and download the batch statistics as JSON. ZIP exports include
   all completed masks, including completed images from a cancelled or partial
   batch. Duplicate output names receive a numbered suffix.

**Masks contain white roots on a black background.** PNGs use lossless one-bit
grayscale, so foreground is sample value 1 and background is 0. Image libraries
which convert to 8-bit grayscale yield foreground 255 and background 0. Output
dimensions follow EXIF orientation. Previews are reduced with foreground pooling
to keep thin roots visible; exported masks keep every original pixel.

You can preview an input before running. Starting a batch closes the preview and
releases its bitmap. No thumbnails, overlays or PNGs are generated during
inference. Only one image is decoded at a time. Completed masks are packed at one
bit per pixel (about 5.3 MiB per supplied 44.8 MP image); export streams packed
rows through `CompressionStream`, without allocating a full-resolution canvas.
Batch ZIP export encodes one mask at a time and stores the compressed PNGs in a
standard ZIP archive, without another compression pass or any image decoding.
The runtime and decoded image still require substantial memory. Closing or
reloading the page discards results.

## Model and tiling

Smith, A. G., Lamprinidis, S., Wlaszczyk, A., & Petersen, J. (2026).
[*A Root Foundation Model for Zero-Shot Segmentation*](https://www.biorxiv.org/content/10.64898/2026.05.14.725129v2.full).
bioRxiv, version 2. DOI: [10.64898/2026.05.14.725129](https://doi.org/10.64898/2026.05.14.725129).
The app displays this citation and provides [a BibTeX file](models/RootFM.bib).

- Source: [Root Foundation Model on Zenodo](https://doi.org/10.5281/zenodo.20180274)
  by Abraham Smith, Sotiris Lamprinidis, Agata Wlaszczyk and Jens Petersen.
- [RootFoundation code](https://github.com/Abe404/RootFoundation), with its
  [MIT notice](licenses/RootFoundation-MIT.txt).
- This repository includes the FP32 export copied from
  `rhizo-mobilesam-segmentation-test.local/weights/onnx/rootfm_fp32.onnx`.
  The sibling project's `scripts/onnx/export.py` describes its conversion.
- SHA-256: `ab9f6a97023599bf427ef9960e5fd81172fb7bca5e7a536b9eecd5246fe3125a`.
  Both the build and browser check the hash.
- Input: `pixels`, uint8 RGBA `[1, 1024, 1024, 4]`. The graph ignores alpha and
  includes ImageNet normalization, prompt-free encoder/decoder inference and
  bilinear logit upsampling. Output: float32 `logits` `[1, 1024, 1024]`.
- Browser decode respects EXIF orientation and disables color-space conversion
  to match the linked Python pipeline.
- Images smaller than 1024 are centered on black padding, then cropped back.
  Larger images keep their original resolution. Tile starts advance by 1024;
  the final tile is shifted to the image edge. Processing order is x then y,
  and later tiles replace overlap. Logits >= 0 identify roots.
- Each supplied photo is 5464 x 8192 after orientation, or 48 tiles. All eight
  require 384 tiles. These known dimensions are in the sample manifest; user
  files are decoded once for planning and again for processing.

FP16 and INT8 are deliberately excluded: the linked project's previous accuracy
comparison found materially different masks, especially FP16 on WebGPU. Both
backends here use the same FP32 weights. Small floating-point differences
between devices can still change pixels near the threshold.

## Runtime choice

Direct **ONNX Runtime Web** is a good fit for this existing custom ONNX graph:
it provides GPU and CPU options through one API. Transformers.js also uses ONNX
Runtime and would add a model/pipeline wrapper without simplifying this graph's
custom inputs. A native ONNX Runtime or OpenVINO application could improve CPU
speed or device access, but would require an installed application or backend.

The app pins `onnxruntime-web` 1.30.0 and serves the matching modules and WASM
binaries from the same origin. Browser inference runs in a dedicated module
worker. WebGPU selection requests a high-performance adapter; ONNX Runtime can
execute unsupported graph operations on WASM. A failed WebGPU session is
reported, so the user can explicitly choose CPU. There is no silent backend
switch or reduced-resolution mode.

CPU uses **one WASM thread**. ONNX Runtime requires cross-origin isolation for
multithreaded WASM. Standard GitHub Pages does not provide custom COOP/COEP
response headers, so this proof of concept works without a service worker that
rewrites headers. For faster CPU work, a future version could add an optional
isolation service worker or use a host supporting those headers.

The model is stored with the Cache API when storage is available. Cache failure
does not prevent inference; reloading may download the model again. Uploaded
images and output masks are never stored in this cache.

References: [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/),
[runtime flags and thread requirements](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html),
[Transformers.js backend](https://huggingface.co/docs/transformers.js/api/backends/onnx).

## Timing definitions

All durations are measured with `performance.now()` and exported in milliseconds.

| Statistic | Includes |
| --- | --- |
| Total wall time | File preparation, model download/cache read and verification, session initialization, all images and worker completion |
| Per-image time | Image fetch/read, decode, tile preparation, inference/readback, stitching, and foreground counting |
| Per-tile time | Pixel preparation, inference/readback, and stitching |
| Inference time | `session.run` and fetching output tensor data |
| Export time | PNG encoding and creation of a PNG or batch ZIP download; recorded separately |

The first tile is included in all means. No hidden warmup runs are performed.
JSON also records every tile's coordinates and preparation/inference/stitch
times, per-image medians/min/max/first/steady median, model load and session
times, GPU adapter information, cache status, browser identity, errors and
cancellation status. The summary's per-image mean covers completed images;
its per-tile mean covers all finished tiles, including tiles from an image
that was later cancelled or failed. Do not compare total time with per-image
time without accounting for shared setup and preparation costs.

## GitHub Pages

The site uses GitHub Pages' **Deploy from a branch** mode, serving the root of
`gh-pages`. Source lives on `main`. To publish an update, commit your changes,
push `main`, then run:

```bash
npm run deploy
```

This requires a GitHub CLI login (`gh auth login`) with repository write and
Pages administration access. The script builds the static files, commits only
`dist/` contents to `gh-pages` using a temporary Git index, pushes that branch,
and configures Pages. The source checkout stays on its current branch. It does
not require the OAuth `workflow` scope. All app, worker, model, runtime and
sample paths are relative, including deployment below `/segmentation-benchmark/`.

An optional Actions template is in `deployment/pages-workflow.yml`. To use it,
copy it into `.github/workflows/` with a login authorized to write workflows,
and switch the Pages source to GitHub Actions.

The ONNX model is about 48.2 MiB and is tracked as an ordinary file. `dist/`,
`node_modules/`, generated tests and the local sibling symlink are ignored.
Only the exported model and explicitly included test photos are deployed.

## Verification

```bash
npm test
npm run build
npx playwright install chromium  # Only if a test browser is not already installed.
npm run test:browser             # Real CPU and available WebGPU inference on photo crops.
npm run test:browser -- --full   # Also processes all 8 full-resolution samples on WebGPU.
```

Unit tests cover tile coverage/order, centered padding, overlap replacement,
logit thresholding, packed mask boundaries, timing summaries and PNG pixel
convention. Browser checks use the deployed build under a repository subpath,
exercise multi-file batches with real model inference, and check mask downloads,
previews, themes, mobile layout, cancellation and recovery from an invalid image.
Artifacts are written to ignored `test-results/`.

Validated on 2026-11-23 with headless Chromium 156 and an NVIDIA Pascal WebGPU
adapter: all eight full-resolution test photos completed (384 tiles) in 78.56 s,
averaging 9.54 s per image and 0.187 s per tile. The cached model was used for
that run. CPU inference on two real-photo crops (including centered padding
and edge overlap) matched native FP32 ONNX inference with zero pixel differences.
The first full-resolution WebGPU output differed from native FP32 by one pixel
out of 44,761,088, adding one foreground pixel and losing none.
These are local measurements, not performance guarantees for other devices.

The browser test enables GPU access flags for headless Chromium on Linux. This
only affects automated tests; visitors use their browser's normal GPU settings.
CPU inference is always tested. When no GPU adapter is available, the script
explicitly reports that GPU inference was skipped.
