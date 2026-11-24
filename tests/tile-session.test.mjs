import test from 'node:test';
import assert from 'node:assert/strict';
import { createTileSession } from '../src/tile-session.js';

test('a rejected graph replay retries the same tile and keeps using regular WebGPU', async t => {
  if (!globalThis.GPUBufferUsage) {
    globalThis.GPUBufferUsage = { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4 };
    t.after(() => { delete globalThis.GPUBufferUsage; });
  }
  const model = Uint8Array.of(1);
  const calls = [];
  const uploads = [];
  const buffer = { destroy: t.mock.fn() };
  const gpuInput = { dispose: t.mock.fn() };
  const device = {
    createBuffer: () => buffer,
    queue: { writeBuffer: (_, offset, bytes) => uploads.push(bytes[0]) },
  };
  const result = value => ({ logits: {
    type: 'float32', dims: [1, 1024, 1024],
    getData: async () => Float32Array.of(value), dispose() {},
  } });
  class Tensor {
    constructor(type, data) { this.data = data; }
    static fromGpuBuffer() { return gpuInput; }
    dispose() {}
  }
  const capture = {
    run: async ({ pixels }) => {
      assert.equal(pixels, gpuInput);
      if (uploads.length === 2) throw new Error('Replay unavailable');
      return result(uploads.at(-1));
    },
    release: t.mock.fn(),
  };
  const regular = { run: async ({ pixels }) => result(pixels.data[0]), release: t.mock.fn() };
  const ort = { Tensor, env: { webgpu: { device } }, InferenceSession: {
    async create(bytes, options) {
      assert.equal(bytes, model);
      calls.push(options);
      return options.enableGraphCapture ? capture : regular;
    },
  } };
  const reload = t.mock.fn(async () => model);
  const fallback = t.mock.fn();
  const session = await createTileSession(ort, model, 'webgpu', reload, fallback);
  for (const value of [10, 20, 30]) {
    assert.deepEqual(await session.run(Uint8Array.of(value)), Float32Array.of(value));
  }
  assert.deepEqual(uploads, [10, 20]);
  assert.deepEqual(calls[0].freeDimensionOverrides, { batch: 1 });
  assert.deepEqual(calls[1].executionProviders, ['webgpu']);
  assert.equal(calls.length, 2);
  assert.equal(session.graphCapture, false);
  assert.equal(reload.mock.callCount(), 1);
  assert.match(fallback.mock.calls[0].arguments[0].message, /Replay unavailable/);
  await session.release();
  for (const cleanup of [capture.release, gpuInput.dispose, buffer.destroy, regular.release]) {
    assert.equal(cleanup.mock.callCount(), 1);
  }
});
