import test from 'node:test';
import assert from 'node:assert/strict';
import { createCpuPool } from '../src/cpu-pool.js';

// A fake worker that answers each run after a delay, echoing the tile's first byte.
function fakeWorker(log, { delay = () => 0, failRun = false } = {}) {
  const worker = {
    terminated: false,
    postMessage(message, transfer = []) {
      if (message.type === 'init') {
        log.push(['init', message.threads, message.bytes.length]);
        queueMicrotask(() => worker.onmessage({ data: { type: 'ready', threads: message.threads } }));
        return;
      }
      assert.deepEqual(transfer, [message.rgba.buffer]);
      const value = message.rgba[0];
      setTimeout(() => worker.onmessage({ data: failRun
        ? { type: 'error', error: `bad tile ${value}` }
        : { type: 'result', logits: Float32Array.of(value), inferenceMs: 1 } }), delay(value));
    },
    terminate() { worker.terminated = true; },
  };
  return worker;
}

test('the pool runs tiles concurrently and returns each tile its own logits', async () => {
  const log = [], workers = [];
  const pool = await createCpuPool(2, 2, Uint8Array.of(1, 2, 3), () => {
    const w = fakeWorker(log, { delay: v => (v % 2 ? 5 : 15) }); workers.push(w); return w;
  });
  assert.deepEqual(log, [['init', 2, 3], ['init', 2, 3]]);
  assert.equal(pool.threads, 4);
  const results = await Promise.all([1, 2, 3, 4, 5].map(v => pool.run(Uint8Array.of(v))));
  assert.deepEqual(results.map(r => r.logits[0]), [1, 2, 3, 4, 5]);
  await pool.release();
  assert.ok(workers.every(w => w.terminated));
});

test('a failed tile rejects only that run and frees the session', async () => {
  let n = 0;
  const pool = await createCpuPool(1, 2, Uint8Array.of(1), () => fakeWorker([], { failRun: n++ === 0 }));
  await assert.rejects(pool.run(Uint8Array.of(7)), /bad tile 7/);
  await assert.rejects(pool.run(Uint8Array.of(8)), /bad tile 8/);
  await pool.release();
});

test('a crashed worker rejects its tile and the rest of the pool continues', async () => {
  const workers = [];
  const pool = await createCpuPool(2, 2, Uint8Array.of(1), () => { const w = fakeWorker([], { delay: () => 5 }); workers.push(w); return w; });
  const first = pool.run(Uint8Array.of(1));
  await new Promise(resolve => setImmediate(resolve));
  workers[0].onerror({ message: 'out of memory' });
  await assert.rejects(first, /out of memory/);
  assert.equal((await pool.run(Uint8Array.of(2))).logits[0], 2);
  workers[1].onerror({ message: 'gone' });
  await assert.rejects(pool.run(Uint8Array.of(3)), /All CPU inference workers stopped/);
  await pool.release();
});

test('a failed initialization terminates every worker', async () => {
  const workers = [];
  await assert.rejects(createCpuPool(2, 2, Uint8Array.of(1), () => {
    const w = { postMessage() { queueMicrotask(() => w.onmessage({ data: { type: 'error', error: 'no memory' } })); }, terminate() { w.terminated = true; } };
    workers.push(w); return w;
  }), /no memory/);
  assert.ok(workers.every(w => w.terminated));
});
