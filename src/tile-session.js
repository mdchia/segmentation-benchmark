import { TILE } from './core.js';

const pixelShape = [1, TILE, TILE, 4];

async function readLogits(session, input) {
  const outputs = await session.run({ pixels: input });
  try {
    const output = outputs.logits;
    if (output?.type !== 'float32' || output.dims.join(',') !== `1,${TILE},${TILE}`) {
      throw new Error('Unexpected model output. Expected float32 logits [1,1024,1024].');
    }
    return await output.getData();
  } finally {
    for (const tensor of Object.values(outputs)) tensor.dispose();
  }
}

export async function createTileSession(ort, bytes, backend, reloadBytes, onFallback) {
  const options = { executionProviders: [backend], graphOptimizationLevel: 'all' };
  const openRegular = model => ort.InferenceSession.create(model, options);
  let session, device, buffer, gpuInput;

  async function release() {
    try {
      await session?.release();
    } finally {
      gpuInput?.dispose();
      buffer?.destroy();
      session = gpuInput = buffer = null;
    }
  }

  if (backend === 'webgpu') {
    try {
      session = await ort.InferenceSession.create(bytes, {
        ...options,
        executionProviders: [{ name: 'webgpu' }],
        freeDimensionOverrides: { batch: 1 },
        enableGraphCapture: true,
        preferredOutputLocation: 'gpu-buffer',
      });
      device = ort.env.webgpu.device;
      // Replay uses the same buffer address for every tile. ORT owns the GPU output.
      buffer = device.createBuffer({
        size: TILE * TILE * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
      gpuInput = ort.Tensor.fromGpuBuffer(buffer, { dataType: 'uint8', dims: pixelShape });
    } catch (error) {
      await release();
      onFallback(error);
    }
  }
  if (!session) session = await openRegular(bytes);
  bytes = null;

  return {
    get graphCapture() { return Boolean(gpuInput); },
    async run(rgba) {
      if (gpuInput) {
        try {
          device.queue.writeBuffer(buffer, 0, rgba);
          return await readLogits(session, gpuInput);
        } catch (error) {
          // Some adapters reject capture on their first dispatch or replay.
          // Retry the same tile on WebGPU and keep the regular session for the batch.
          await release();
          onFallback(error);
        }
      }
      if (!session) session = await openRegular(await reloadBytes());
      const input = new ort.Tensor('uint8', rgba, pixelShape);
      try {
        return await readLogits(session, input);
      } finally {
        input.dispose();
      }
    },
    release,
  };
}
