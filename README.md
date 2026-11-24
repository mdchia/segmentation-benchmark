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
binaries, the verified browser model, and the eight supplied test images. The
linked sibling project is not required to build or run the app.
Builds use content-versioned module and stylesheet paths so browser caches
cannot mix a new page with older app code.

## Use

1. Select WebGPU or CPU. WebGPU is disabled when no adapter is detected. In CPU
   mode, the second menu selects **Auto / 1 / 2 / 4 / 8 threads**. Auto uses half
   the reported logical cores, rounded up and capped at eight. Explicit settings
   are honored even when they exceed the reported core count, so testers can
   compare throughput. The preference is remembered in this browser.
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
- The build verifies the source export, then generates
  `rootfm_fp32_rgb_gather.onnx`. It replaces the uint8 alpha-removal `Slice` with
  an equivalent `Gather` of R, G and B, which ONNX Runtime 1.30 can run on WebGPU.
  It also removes a Slice constant with no remaining consumers. The FP32
  weights and the other operations come from the source export.
  The build and browser verify the generated model's SHA-256
  (`2cf714a8043ba4cad29b59cddb00dc3cc9a683c6aa2f3fa6231d752c0761610d`).
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

The app pins the ONNX Runtime Web prerelease
`1.33.0-dev.20261112-74f861c52` and serves its modules and WASM binaries from
a versioned directory on the same origin. Repeated sessions on the RTX 5060
Laptop GPU sometimes produced different masks with 1.30.0 and 1.31.1.
On 1.31.1, a projection weight buffer on the GPU differed between sessions
even though the uploaded source bytes matched. The pinned build uses queue
writes for smaller parameter uploads and reproduced the same masks in repeated
full batches. CPU runs use the smaller WASM-only runtime. WebGPU uses the
JavaScript Promise Integration (JSPI) build when the browser supports it and
the Asyncify build otherwise.

The worker requests a high-performance adapter and tells ONNX Runtime that
the model's batch dimension is always one. It uploads each tile to the same
4 MiB GPU buffer, allowing ONNX Runtime to capture and replay the graph.
The runtime manages the output buffer and reads back FP32 logits for stitching.
The tile canvas also skips smoothing for its one-to-one pixel copies. If an
adapter rejects graph capture, the worker retries on regular WebGPU. The JSON
records `gpu.graphCapture` and the fallback reason when one is available.
Failures of regular WebGPU are reported in the UI.

CPU supports **Auto / 1 / 2 / 4 / 8 WASM threads** within one inference session,
sharing the model and processing images sequentially. WebGPU uses one WASM helper
thread and disables the CPU thread menu. Use per-tile and per-image timings to
compare CPU settings on each machine.

ONNX Runtime requires cross-origin isolation and shared memory for multiple
WASM threads. `isolation-worker.js` adds COOP/COEP headers to same-origin app
responses on GitHub Pages. On the first visit, the page may reload once before
file input is enabled. This worker does not cache responses or images. Browsers
that cannot enable threading continue with one thread and disable unsupported
thread choices. No server configuration or third-party script is required.
Stats report the selected setting, requested count, initialized runtime count,
isolation state and reported logical core count. Runtime thread counts describe
the thread pool; CPU scheduling and utilization remain browser/OS controlled.

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
| Inference time | Input tensor binding or upload, `session.run`, and output readback |
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

The included `.github/workflows/pages.yml` builds and deploys `dist/` on pushes to
`main`, or on manual dispatch. Set **Settings > Pages > Build and deployment >
Source** to **GitHub Actions**. All app, worker, model, runtime and sample paths
are relative, including deployment below `/segmentation-benchmark/`.

After pushing source changes, deployment starts automatically. `npm run deploy`
can also trigger the workflow using an existing GitHub CLI login. The login used
to push workflow changes needs GitHub's `workflow` OAuth scope; repository write
permission and enabling Actions in Settings do not grant that token scope.

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
They repeat a four-tile WebGPU image in fresh sessions and compare the exported
PNGs byte for byte. They also exercise all five CPU settings with real inference,
verify the initialized thread count and byte-for-byte mask parity, and check the
one-thread fallback when service workers are unavailable.
Artifacts are written to ignored `test-results/`.

### CPU thread scaling

On 2026-11-25, Chromium 156 processed the full-resolution Box053 sample
(5464 × 8192, 48 tiles) on a Ryzen 7 250 laptop. Auto increased from four to
eight WASM threads on its eight physical cores and sixteen logical CPUs. With
the model cached, the mean batch time fell from **48.65 s to 35.96 s (26%)**,
and median inference after the first tile fell from **978 ms to 701 ms (28%)**.
The timings average two fresh sessions per setting in 4 / 8 / 8 / 4 order.
All four exported mask PNGs were byte-identical.

In shorter laptop sweeps, twelve threads gave a small additional gain in some
runs. Sixteen threads were consistently slower than eight. Each pair of SMT
threads shares a physical core's compute resources. Auto uses the browser's
reported logical CPU count to size the pool, with a cap of eight.

On a Pixel 11 Pro, Chrome 158 reported seven logical CPUs and Auto chose four
WASM threads in both builds. The same 48-tile photo produced identical mask PNGs
in the phone's four- and six-thread runs. Batch time at four threads ranged from
78 s to 145 s as the phone warmed, so the phone runs establish mask parity and
thread selection. The laptop runs provide the speed comparison above.

### WebGPU graph replay and runtime comparison

On 2026-11-25, we compared the pinned runtime and graph replay with the
previous RGB Gather build (`1031c3a`). Both builds used the same verified
FP32 model, original-resolution photos and tile order. The table shows
model-cached runs. Steady inference is the median across all tiles after the
first and includes GPU upload and output readback.

| Device and workload | Previous wall time | Updated wall time | Previous steady inference | Updated steady inference |
| --- | ---: | ---: | ---: | ---: |
| RTX 5060 Laptop GPU, Chromium 156, all eight photos (384 tiles) | 33.81 s | 25.23 s | 54.39 ms | 38.53 ms |
| Pixel 11 Pro, Android 17, Chrome 158, Box053 (48 tiles) | 136.39 s | 87.23-87.72 s | 2.453 s | 1.502 s |

The laptop also finished the model-cache miss in 25.45 s, down from 34.39 s.
The phone ran the updated build twice with the previous build between those
runs. Earlier cached baseline runs on the phone ranged from 122.55 to 136.63 s.

Three updated laptop batches produced identical PNGs. One of 358,088,704
output pixels differed from the previous build, in Box057. Both updated
phone runs also produced identical PNGs. One of 44,761,088 pixels differed
from the previous build, in Box053. Both differences changed a root pixel to
background. With the same decoded input bytes, the original native FP32 model
gave logits of +0.00000215 for the laptop pixel and +0.00000328 for the phone
pixel, both just above the zero threshold. The CPU edge-crop PNG matched
across both versions on both devices.

### Earlier measurements

On 2026-11-25, paired runs in Chromium 156 on an NVIDIA RTX 5060 Laptop GPU
processed the eight full-resolution photos (384 tiles) with cached models.
The RGB `Gather` reduced median inference time after the first tile from
68.0 ms to 54.9 ms and reduced batch wall time from 38.75 s to 33.79 s.
The eight exported mask PNGs matched the original graph byte for byte.
Native FP32 also matched the first photo's mask exactly when fed the same
Chromium-decoded tiles. Pillow decoded some RGB values differently on this
machine, which affected the optional full-photo reference comparison.

On 2026-11-23, the original graph ran in headless Chromium 156 on an NVIDIA
Pascal WebGPU adapter. All eight full-resolution test photos (384 tiles)
completed in 78.56 s, averaging 9.54 s per image and 0.187 s per tile.
The cached model was used for
that run. CPU inference on two real-photo crops (including centered padding
and edge overlap) matched native FP32 ONNX inference with zero pixel differences.
The first full-resolution WebGPU output differed from native FP32 by one pixel
out of 44,761,088, adding one foreground pixel and losing none.
Performance varies across devices.

The browser test enables GPU access flags for headless Chromium on Linux. This
only affects automated tests; visitors use their browser's normal GPU settings.
CPU inference is always tested. When no GPU adapter is available, the script
explicitly reports that GPU inference was skipped.
