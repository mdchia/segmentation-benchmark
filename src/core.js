export const ORT_VERSION = '1.33.0-dev.20261112-74f861c52';
export const TILE = 1024;
export const MODEL_FILE = 'rootfm_fp32_rgb_gather.onnx';
export const MODEL_SHA256 = '2cf714a8043ba4cad29b59cddb00dc3cc9a683c6aa2f3fa6231d752c0761610d';

export function axisStarts(size, tile = TILE) {
  if (size <= tile) return [0];
  const starts = [];
  for (let v = 0; v < size - tile; v += tile) starts.push(v);
  starts.push(size - tile);
  return starts;
}

export function planTiles(width, height, tile = TILE) {
  if (![width, height, tile].every(v => Number.isInteger(v) && v > 0)) throw new Error('Invalid image dimensions.');
  const left = Math.floor(Math.max(0, tile - width) / 2);
  const top = Math.floor(Math.max(0, tile - height) / 2);
  const coords = [];
  for (const x of axisStarts(width, tile)) for (const y of axisStarts(height, tile)) coords.push({ x, y });
  return { width, height, left, top, tile, coords };
}

export function packedLength(width, height) { return Math.ceil(width / 8) * height; }

export function maskPixel(mask, width, x, y) {
  return (mask[y * Math.ceil(width / 8) + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
}

export function stitchTile(mask, logits, plan, coord) {
  const { width, height, left, top, tile } = plan;
  const rowBytes = Math.ceil(width / 8);
  const x0 = Math.max(0, coord.x - left), y0 = Math.max(0, coord.y - top);
  const x1 = Math.min(width, coord.x - left + tile), y1 = Math.min(height, coord.y - top + tile);
  for (let y = y0; y < y1; y++) {
    const row = y * rowBytes;
    const src = (y - coord.y + top) * tile;
    for (let x = x0; x < x1; x++) {
      const value = logits[src + x - coord.x + left];
      if (!Number.isFinite(value)) throw new Error('Model returned non-finite logits. Try CPU or another GPU/browser.');
      const i = row + (x >> 3), bit = 0x80 >> (x & 7);
      if (value >= 0) mask[i] |= bit;
      else mask[i] &= ~bit;
    }
  }
}

const POPCOUNT = Uint8Array.from({ length: 256 }, (_, n) => {
  let count = 0;
  for (; n; n &= n - 1) count++;
  return count;
});
export function foregroundPixels(mask) { return mask.reduce((n, byte) => n + POPCOUNT[byte], 0); }

export function timingSummary(tiles) {
  if (!tiles.length) return { count:0, meanMs:0, meanInferenceMs:0, firstMs:0, minMs:0, maxMs:0, medianMs:0, steadyMedianMs:null };
  const sorted = tiles.map(t => t.totalMs).sort((a,b) => a-b);
  const median = a => (a[Math.floor((a.length-1)/2)] + a[Math.floor(a.length/2)]) / 2;
  const steady = tiles.slice(1).map(t => t.totalMs).sort((a,b) => a-b);
  return { count:tiles.length, meanMs:tiles.reduce((s,t)=>s+t.totalMs,0)/tiles.length,
    meanInferenceMs:tiles.reduce((s,t)=>s+t.inferenceMs,0)/tiles.length,
    firstMs:tiles[0].totalMs, minMs:sorted[0], maxMs:sorted.at(-1), medianMs:median(sorted),
    steadyMedianMs:steady.length ? median(steady) : null };
}
