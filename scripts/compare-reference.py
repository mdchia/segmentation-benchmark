"""Optional native ONNX parity check for browser-test photo crops.

Requires numpy, Pillow and onnxruntime. These are not app dependencies.
Run after npm run test:browser: python scripts/compare-reference.py
"""
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
TILE = 1024
options = ort.SessionOptions()
options.intra_op_num_threads = 2
session = ort.InferenceSession(str(ROOT / "models/rootfm_fp32.onnx"), options,
                               providers=["CPUExecutionProvider"])


def starts(size):
    return sorted(set([*range(0, max(0, size - TILE), TILE), max(0, size - TILE)]))


report = []
cases = [(ROOT / "test-results" / name, ROOT / "test-results" / f"cpu-{name}")
         for name in ("small.png", "edges.png")]
if "--full" in sys.argv:
    cases.append((ROOT / "test-data/2025-07-24_Box053.JPG", ROOT / "test-results/gpu-mask.png"))
for source, output in cases:
    name = source.name
    image = ImageOps.exif_transpose(Image.open(source)).convert("RGB")
    width, height = image.size
    pad_h, pad_w = max(0, TILE - height), max(0, TILE - width)
    top, left = pad_h // 2, pad_w // 2
    reference = np.zeros((height, width), dtype=bool)
    tile_index = 0
    for x in starts(max(TILE, width)):
        for y in starts(max(TILE, height)):
            rgba = np.full((1, TILE, TILE, 4), 255, np.uint8)
            rgba[0, :, :, :3] = np.asarray(image.crop((x-left, y-top, x-left+TILE, y-top+TILE)))
            logits = session.run(None, {"pixels": rgba})[0][0]
            x0, y0 = max(0, x-left), max(0, y-top)
            x1, y1 = min(width, x-left+TILE), min(height, y-top+TILE)
            reference[y0:y1, x0:x1] = logits[y0-y+top:y1-y+top, x0-x+left:x1-x+left] >= 0
            tile_index += 1
            if tile_index % 8 == 0:
                print(f"{name}: compared reference tile {tile_index}", flush=True)
    image.close()
    browser_image = Image.open(output)
    assert browser_image.size == (width, height), browser_image.size
    browser = np.array(browser_image.convert("L")) > 0
    lost, added = int((reference & ~browser).sum()), int((~reference & browser).sum())
    row = {"image": name, "width": width, "height": height,
           "native_foreground": int(reference.sum()), "browser_foreground": int(browser.sum()),
           "lost_pixels": lost, "added_pixels": added}
    report.append(row)
    print(json.dumps(row), flush=True)
    assert lost + added <= max(5, int(reference.sum()) * 1e-4), "Unexpected mask mismatch against native FP32 inference"
(ROOT / "test-results" / "native-parity.json").write_text(json.dumps(report, indent=2) + "\n")
