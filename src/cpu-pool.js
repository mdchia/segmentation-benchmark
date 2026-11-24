// Runs tiles on several CPU sessions, each in its own worker with its own
// WASM thread pool. Each worker processes one tile at a time.
export async function createCpuPool(count, threadsPerSession, bytes, createWorker) {
  const entries = [], idle = [], waiting = [];
  const live = () => entries.filter(entry => !entry.dead);
  const request = (entry, message, transfer = []) => new Promise((resolve, reject) => {
    if (entry.dead) { reject(new Error('A CPU inference worker stopped unexpectedly.')); return; }
    entry.pending = { resolve, reject };
    entry.worker.postMessage(message, transfer);
  });
  for (let i = 0; i < count; i++) {
    const entry = { worker: createWorker(), pending: null, dead: false };
    entry.worker.onmessage = ({ data }) => {
      const pending = entry.pending;
      entry.pending = null;
      if (data.type === 'error') pending?.reject(new Error(data.error));
      else pending?.resolve(data);
    };
    entry.worker.onerror = event => {
      event.preventDefault?.();
      entry.dead = true;
      entry.pending?.reject(new Error(event.message || 'A CPU inference worker stopped unexpectedly.'));
      entry.pending = null;
      if (!live().length) for (const waiter of waiting.splice(0)) waiter.reject(new Error('All CPU inference workers stopped.'));
    };
    entries.push(entry);
  }
  let ready;
  try {
    ready = await Promise.all(entries.map(entry => request(entry, { type: 'init', threads: threadsPerSession, bytes })));
  } catch (error) {
    for (const entry of entries) entry.worker.terminate();
    throw error;
  }
  idle.push(...entries);

  function acquire() {
    while (idle.length) {
      const entry = idle.shift();
      if (!entry.dead) return Promise.resolve(entry);
    }
    if (!live().length) return Promise.reject(new Error('All CPU inference workers stopped.'));
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  }
  function free(entry) {
    if (entry.dead) return;
    const waiter = waiting.shift();
    if (waiter) waiter.resolve(entry);
    else idle.push(entry);
  }

  return {
    sessions: count,
    threads: ready.reduce((sum, r) => sum + r.threads, 0),
    async run(rgba) {
      let entry = await acquire();
      // A session that stopped before receiving this tile hands it to another.
      while (entry.dead) entry = await acquire();
      try {
        const { logits, inferenceMs } = await request(entry, { type: 'run', rgba }, [rgba.buffer]);
        return { logits, inferenceMs };
      } finally {
        free(entry);
      }
    },
    async release() {
      for (const entry of entries) entry.worker.terminate();
      for (const waiter of waiting.splice(0)) waiter.reject(new Error('CPU sessions closed.'));
    },
  };
}
