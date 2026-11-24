// One CPU inference session of a parallel Auto pool. The batch worker sends
// prepared RGBA tiles and stitches the returned logits in tile order.
import { ORT_VERSION } from './core.js';
import { createTileSession } from './tile-session.js';

let session;
const errorText = e => e?.message || String(e);

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const vendor = new URL(`../vendor-${ORT_VERSION}/`, import.meta.url);
      const ort = await import(new URL('ort.wasm.min.mjs', vendor).href);
      ort.env.wasm.wasmPaths = vendor.href;
      ort.env.wasm.numThreads = data.threads;
      ort.env.wasm.proxy = false;
      session = await createTileSession(ort, data.bytes, 'wasm', async () => { throw new Error('CPU session closed.'); }, () => {});
      self.postMessage({ type: 'ready', threads: ort.env.wasm.numThreads });
    } else if (data.type === 'run') {
      const start = performance.now();
      let logits = await session.run(data.rgba);
      const inferenceMs = performance.now() - start;
      if (logits.byteOffset || logits.byteLength !== logits.buffer.byteLength) logits = logits.slice();
      self.postMessage({ type: 'result', logits, inferenceMs }, [logits.buffer]);
    }
  } catch (e) {
    self.postMessage({ type: 'error', error: errorText(e) });
  }
};
