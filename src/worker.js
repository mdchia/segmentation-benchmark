import { ORT_VERSION, TILE, MODEL_FILE, MODEL_SHA256, planTiles, packedLength, stitchTile, foregroundPixels, timingSummary } from './core.js';
import { cpuThreadCount, cpuSessionPlan, supportsCpuThreads } from './threads.js';
import { createCpuPool } from './cpu-pool.js';
import { createTileSession } from './tile-session.js';

const emit = (type, data = {}, transfer = []) => self.postMessage({ type, ...data }, transfer);
const now = () => performance.now();
const errorText = e => e?.message || String(e);

async function loadModel(reportProgress = true) {
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
    if (reportProgress) emit('model-progress', { loadedBytes, totalBytes, cacheHit });
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
  const cpuPlan=backend==='wasm'?cpuSessionPlan(threadSetting,navigator.hardwareConcurrency,navigator.deviceMemory,supportsCpuThreads(),totalTiles):null;
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
  let runner=null, cpuPoolFallback=null;
  if (cpuPlan?.sessions>1) {
    try {
      runner=await createCpuPool(cpuPlan.sessions,cpuPlan.threadsPerSession,model.bytes,
        ()=>new Worker(new URL('./cpu-worker.js',import.meta.url),{type:'module'}));
    } catch(e) {
      // Fewer resources than planned: continue with one session and every thread.
      cpuPoolFallback=errorText(e);
    }
  }
  let threads;
  if (runner) threads=runner.threads;
  else {
    const vendor=new URL(`../vendor-${ORT_VERSION}/`,import.meta.url);
    let runtimeModule='ort.wasm.min.mjs';
    if (backend==='webgpu') runtimeModule='Suspending' in WebAssembly?'ort.jspi.min.mjs':'ort.webgpu.min.mjs';
    const ort=await import(new URL(runtimeModule,vendor).href);
    ort.env.wasm.wasmPaths=vendor.href;
    ort.env.wasm.numThreads=supportsCpuThreads()?requestedThreads:1;
    ort.env.wasm.proxy=false;
    if(adapter) ort.env.webgpu.adapter=adapter;
    const session=await createTileSession(ort,model.bytes,backend,async()=>(await loadModel(false)).bytes,error=>{
      gpu.graphCapture=false;
      gpu.graphCaptureFallback=errorText(error);
      emit('gpu-mode',{gpu});
    });
    if (gpu) gpu.graphCapture=session.graphCapture;
    threads=ort.env.wasm.numThreads;
    runner={sessions:1,async run(rgba){const start=now();const logits=await session.run(rgba);return {logits,inferenceMs:now()-start};},release:()=>session.release()};
  }
  const sessionInitMs=now()-sessionStart;
  const modelInfo={sha256:MODEL_SHA256,cacheHit:model.cacheHit,cacheStored:model.cacheStored,bytes:model.loadedBytes};
  model=null;
  const setupMs=now()-setupStart;
  const sessions=runner.sessions;
  emit('started', {totalTiles,preflightMs,setupMs,modelLoadMs,sessionInitMs,model:modelInfo,backend,gpu,
    threadSetting,requestedThreads,threads,sessions,threadsPerSession:threads/sessions,cpuPoolFallback,
    crossOriginIsolated:Boolean(self.crossOriginIsolated),hardwareConcurrency:navigator.hardwareConcurrency,deviceMemory:navigator.deviceMemory??null,
    threadWarning:threads<requestedThreads?`Requested ${requestedThreads} CPU threads; this browser's runtime is using ${threads}.`:null});
  const canvas=new OffscreenCanvas(TILE,TILE);
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  if (!ctx) throw new Error('Could not allocate the tile canvas.');
  // Tile crops use integer coordinates and copy pixels at their original size.
  ctx.imageSmoothingEnabled=false;
  let completedTiles=0;
  // Tiles are dispatched and stitched in plan order, so later tiles still replace
  // overlap. With several CPU sessions, the next image's tiles start while the
  // previous image's last tiles finish.
  const inFlight=[];
  const fail=(image,e)=>{
    if (image.failed) return;
    image.failed=true;
    emit('image-error',{id:image.item.id,error:errorText(e),imageMs:now()-image.start});
  };
  async function settleOldest() {
    const job=inFlight.shift();
    const {image,coord}=job;
    let output;
    try { output=await job.result; } catch(e) { fail(image,e); return; }
    if (image.failed) return;
    try {
      const stitchStart=now();
      stitchTile(image.mask,output.logits,image.item.plan,coord);
      const end=now();
      const timing={index:image.tiles.length+1,x:coord.x,y:coord.y,prepMs:job.prepMs,inferenceMs:output.inferenceMs,
        stitchMs:end-stitchStart,totalMs:end-job.tileStart};
      if (sessions>1) timing.waitMs=Math.max(0,timing.totalMs-timing.prepMs-timing.inferenceMs-timing.stitchMs);
      image.tiles.push(timing); completedTiles++;
      emit('tile', {id:image.item.id,completed:image.tiles.length,count:image.item.plan.coords.length,completedTiles,totalTiles,timing});
      if (image.tiles.length===image.item.plan.coords.length) {
        const {item,mask,tiles}=image;
        const foreground=foregroundPixels(mask);
        const result={id:item.id,name:item.name,width:item.width,height:item.height,tiles,imageMs:now()-image.start,decodeMs:image.decodeMs,
          foregroundPixels:foreground,foregroundPercent:100*foreground/(item.width*item.height),
          timing:{...timingSummary(tiles),throughputMs:(end-image.firstTileStart)/tiles.length}};
        emit('image-complete',{id:item.id,result,mask:mask.buffer},[mask.buffer]);
      }
    } catch(e) { fail(image,e); }
  }
  try {
    for (const item of prepared) {
      let bitmap;
      const image={item,start:now(),tiles:[],failed:false};
      emit('image-start', {id:item.id,totalTiles,completedTiles});
      try {
        const blob=await getBlob(item);
        const decodeStart=now();
        bitmap=await decode(blob);
        image.decodeMs=now()-decodeStart;
        if (bitmap.width!==item.width || bitmap.height!==item.height) throw new Error('Decoded dimensions differ from the tile plan.');
        image.mask=new Uint8Array(packedLength(item.width,item.height));
        for (const coord of item.plan.coords) {
          if (image.failed) break;
          const tileStart=now();
          image.firstTileStart??=tileStart;
          ctx.fillStyle='#000'; ctx.fillRect(0,0,TILE,TILE);
          const sx=Math.max(0,coord.x-item.plan.left), sy=Math.max(0,coord.y-item.plan.top);
          const dx=Math.max(0,item.plan.left-coord.x), dy=Math.max(0,item.plan.top-coord.y);
          const w=Math.min(TILE-dx,item.width-sx), h=Math.min(TILE-dy,item.height-sy);
          ctx.drawImage(bitmap,sx,sy,w,h,dx,dy,w,h);
          const rgba=ctx.getImageData(0,0,TILE,TILE).data;
          const result=runner.run(new Uint8Array(rgba.buffer,rgba.byteOffset,rgba.byteLength));
          result.catch(()=>{}); // Handled in tile order by settleOldest.
          inFlight.push({image,coord,tileStart,prepMs:now()-tileStart,result});
          if (inFlight.length>=sessions) await settleOldest();
        }
      } catch(e) { fail(image,e); }
      finally { bitmap?.close(); }
    }
    while (inFlight.length) await settleOldest();
  } finally { await runner.release(); canvas.width=1; canvas.height=1; }
  emit('done', {workerTotalMs:now()-started,totalTiles,completedTiles});
}

self.onmessage=({data})=>{
  if(data.type==='run') run(data).catch(e=>emit('fatal',{error:errorText(e)}));
};
