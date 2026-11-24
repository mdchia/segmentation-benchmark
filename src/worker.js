import { TILE, MODEL_FILE, MODEL_SHA256, planTiles, packedLength, stitchTile, foregroundPixels, timingSummary } from './core.js';
import { cpuThreadCount, supportsCpuThreads } from './threads.js';

const emit = (type, data = {}, transfer = []) => self.postMessage({ type, ...data }, transfer);
const now = () => performance.now();
const errorText = e => e?.message || String(e);

async function loadModel() {
  const url = new URL(`../models/${MODEL_FILE}`, import.meta.url).href;
  let cache;
  try { cache = await caches.open(`rootfm-${MODEL_SHA256.slice(0,12)}`); } catch { /* Storage can be unavailable in private browsing. */ }
  let response;
  try { response = await cache?.match(url); } catch { /* Fetch below remains available. */ }
  const cacheHit = Boolean(response);
  if (!response) response = await fetch(url);
  if (!response.ok) throw new Error(`Model download failed (${response.status}). Check that models/${MODEL_FILE} is deployed.`);
  const cacheCopy = !cacheHit && cache ? response.clone() : null;
  const totalBytes = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const parts = [];
  let loadedBytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value); loadedBytes += value.length;
    emit('model-progress', { loadedBytes, totalBytes, cacheHit });
  }
  const bytes = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const p of parts) { bytes.set(p,offset); offset+=p.length; }
  parts.length = 0;
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b=>b.toString(16).padStart(2,'0')).join('');
  if (digest !== MODEL_SHA256) {
    await cache?.delete(url);
    throw new Error('The model checksum did not match. Reload and try again.');
  }
  let cacheStored = cacheHit;
  if (cacheCopy) {
    try { await cache.put(url, cacheCopy); cacheStored = true; } catch { /* Inference still works when storage is full. */ }
  }
  return { bytes, cacheHit, cacheStored, loadedBytes };
}

async function getBlob(item) {
  if (item.file) return item.file;
  const response = await fetch(new URL(item.url, self.location.href));
  if (!response.ok) throw new Error(`Image download failed (${response.status}).`);
  return response.blob();
}

async function decode(blob) {
  return createImageBitmap(blob, { imageOrientation:'from-image', colorSpaceConversion:'none', premultiplyAlpha:'none' });
}

async function run({ items, backend, threadSetting='auto' }) {
  const started = now();
  if (!self.OffscreenCanvas || !self.createImageBitmap) throw new Error('This browser needs OffscreenCanvas and createImageBitmap support. Try a current Chrome, Edge or Firefox.');
  const prepared = [];
  let totalTiles = 0;
  for (let i=0; i<items.length; i++) {
    const item = items[i];
    emit('preflight', { id:item.id, index:i+1, count:items.length });
    try {
      let width=item.width, height=item.height;
      if (!width || !height) {
        const bitmap=await decode(await getBlob(item));
        width=bitmap.width; height=bitmap.height; bitmap.close();
      }
      const plan=planTiles(width,height);
      prepared.push({ ...item, width, height, plan }); totalTiles+=plan.coords.length;
      emit('image-ready', {id:item.id,width,height,tiles:plan.coords.length});
    } catch(e) { emit('image-error', {id:item.id,error:errorText(e)}); }
  }
  const preflightMs=now()-started;
  if (!prepared.length) { emit('done', {preflightMs,totalTiles:0,completedTiles:0}); return; }

  const requestedThreads=backend==='wasm'?cpuThreadCount(threadSetting,navigator.hardwareConcurrency):1;
  const setupStart=now();
  let gpu=null;
  let adapter;
  if (backend==='webgpu') {
    if (!navigator.gpu) throw new Error('WebGPU is unavailable. Select CPU or use a browser with WebGPU support.');
    adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    if (!adapter) throw new Error('No WebGPU adapter is available. Select CPU or check browser GPU settings.');
    const info=adapter.info || {};
    gpu={vendor:info.vendor,architecture:info.architecture,description:info.description};
  }
  const downloadStart=now();
  let model=await loadModel();
  const modelLoadMs=now()-downloadStart;
  emit('session-loading');
  const sessionStart=now();
  const ort=backend==='wasm'
    ? await import('../vendor/ort.wasm.min.mjs')
    : await import('../vendor/ort.webgpu.min.mjs');
  ort.env.wasm.wasmPaths = new URL('../vendor/', import.meta.url).href;
  ort.env.wasm.numThreads=supportsCpuThreads()?requestedThreads:1;
  ort.env.wasm.proxy=false;
  if(adapter) ort.env.webgpu.adapter=adapter;
  const session=await ort.InferenceSession.create(model.bytes, { executionProviders:[backend], graphOptimizationLevel:'all' });
  const sessionInitMs=now()-sessionStart;
  const modelInfo={sha256:MODEL_SHA256,cacheHit:model.cacheHit,cacheStored:model.cacheStored,bytes:model.loadedBytes};
  model=null;
  const setupMs=now()-setupStart;
  const threads=ort.env.wasm.numThreads;
  emit('started', {totalTiles,preflightMs,setupMs,modelLoadMs,sessionInitMs,model:modelInfo,backend,gpu,
    threadSetting,requestedThreads,threads,crossOriginIsolated:Boolean(self.crossOriginIsolated),hardwareConcurrency:navigator.hardwareConcurrency,
    threadWarning:threads<requestedThreads?`Requested ${requestedThreads} CPU threads; this browser's runtime is using ${threads}.`:null});
  const canvas=new OffscreenCanvas(TILE,TILE);
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  if (!ctx) throw new Error('Could not allocate the tile canvas.');
  let completedTiles=0;
  try {
    for (const item of prepared) {
      let bitmap;
      const imageStart=now();
      emit('image-start', {id:item.id,totalTiles,completedTiles});
      try {
        const blob=await getBlob(item);
        const decodeStart=now();
        bitmap=await decode(blob);
        const decodeMs=now()-decodeStart;
        if (bitmap.width!==item.width || bitmap.height!==item.height) throw new Error('Decoded dimensions differ from the tile plan.');
        const mask=new Uint8Array(packedLength(item.width,item.height));
        const tiles=[];
        for (const coord of item.plan.coords) {
          const tileStart=now();
          ctx.fillStyle='#000'; ctx.fillRect(0,0,TILE,TILE);
          const sx=Math.max(0,coord.x-item.plan.left), sy=Math.max(0,coord.y-item.plan.top);
          const dx=Math.max(0,item.plan.left-coord.x), dy=Math.max(0,item.plan.top-coord.y);
          const w=Math.min(TILE-dx,item.width-sx), h=Math.min(TILE-dy,item.height-sy);
          ctx.drawImage(bitmap,sx,sy,w,h,dx,dy,w,h);
          const rgba=ctx.getImageData(0,0,TILE,TILE).data;
          const input=new ort.Tensor('uint8',new Uint8Array(rgba.buffer),[1,TILE,TILE,4]);
          const prepMs=now()-tileStart;
          const inferenceStart=now();
          let outputs;
          let inferenceMs;
          try {
            outputs=await session.run({pixels:input});
            const output=outputs.logits;
            if (!output || output.dims.join(',')!=='1,1024,1024' || output.type!=='float32') throw new Error('Unexpected model output. Expected float32 logits [1,1024,1024].');
            const logits=await output.getData();
            inferenceMs=now()-inferenceStart;
            stitchTile(mask,logits,item.plan,coord);
          } finally {
            input.dispose();
            if (outputs) for(const tensor of Object.values(outputs)) tensor.dispose();
          }
          const totalMs=now()-tileStart;
          const timing={index:tiles.length+1,x:coord.x,y:coord.y,prepMs,inferenceMs,stitchMs:totalMs-prepMs-inferenceMs,totalMs};
          tiles.push(timing); completedTiles++;
          emit('tile', {id:item.id,completed:tiles.length,count:item.plan.coords.length,completedTiles,totalTiles,timing});
        }
        const foreground=foregroundPixels(mask);
        const imageMs=now()-imageStart;
        const result={id:item.id,name:item.name,width:item.width,height:item.height,tiles,imageMs,decodeMs,
          foregroundPixels:foreground,foregroundPercent:100*foreground/(item.width*item.height),timing:timingSummary(tiles)};
        emit('image-complete',{id:item.id,result,mask:mask.buffer},[mask.buffer]);
      } catch(e) { emit('image-error',{id:item.id,error:errorText(e),imageMs:now()-imageStart}); }
      finally { bitmap?.close(); }
    }
  } finally { await session.release(); canvas.width=1; canvas.height=1; }
  emit('done', {workerTotalMs:now()-started,totalTiles,completedTiles});
}

self.onmessage=({data})=>{
  if(data.type==='run') run(data).catch(e=>emit('fatal',{error:errorText(e)}));
};
