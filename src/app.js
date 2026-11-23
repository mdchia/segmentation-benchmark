import { maskPixel } from './core.js';
import { maskPng } from './png.js';
import { storedZip, uniqueMaskNames } from './zip.js';
import { cpuThreadCount, prepareCpuThreads } from './threads.js';

const $=id=>document.getElementById(id);
const queue=[];
let worker=null, busy=false, exporting=false, batch=null, timer=null, selected=null, previewBitmap=null, previewMask=null, previewVersion=0;
let booting=true,threadingAvailable=false;
const seconds=ms=>`${(ms/1000).toFixed(2)} s`;
const tileSeconds=ms=>`${(ms/1000).toFixed(3)} s`;
const mib=bytes=>`${(bytes/2**20).toFixed(1)} MiB`;
const modeNames={wasm:'CPU (WebAssembly)',webgpu:'WebGPU'};

function setTheme() {
  const choice=$('theme').value;
  document.documentElement.dataset.theme=choice==='system' ? (matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light') : choice;
  try { localStorage.setItem('rootfm-theme',choice); } catch { /* Theme still works without storage. */ }
}
try { $('theme').value=localStorage.getItem('rootfm-theme') || 'system'; } catch { /* Use the system theme. */ }
setTheme();
$('theme').addEventListener('change',setTheme);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',setTheme);

async function checkGpu() {
  let available=false;
  try { available=Boolean(navigator.gpu && await navigator.gpu.requestAdapter()); } catch { /* CPU is available. */ }
  $('backend').querySelector('[value="webgpu"]').disabled=!available;
  if(!available) $('backend').value='wasm';
  $('capability').textContent=available ? 'WebGPU adapter detected. CPU processing is also available.' : 'No WebGPU adapter detected. CPU processing is available.';
  $('webgpu-guidance').hidden=available;
}
try {
  const saved=localStorage.getItem('rootfm-cpu-threads');
  if(['auto','1','2','4','8'].includes(saved))$('threads').value=saved;
} catch { /* Use Auto without persistent storage. */ }

function updateThreadControls() {
  const cpu=$('backend').value==='wasm';
  $('threads').disabled=booting||busy||exporting||!cpu;
  for(const option of $('threads').options)option.disabled=!threadingAvailable&&['2','4','8'].includes(option.value);
  if(booting) {$('thread-info').textContent='Preparing CPU thread support…';return;}
  if(!threadingAvailable&&['2','4','8'].includes($('threads').value))$('threads').value='1';
  $('thread-info').textContent=!cpu?'CPU thread settings apply when CPU processing is selected.':threadingAvailable
    ? `Auto uses ${cpuThreadCount('auto',navigator.hardwareConcurrency)} threads. Choose a count to compare CPU performance.`
    : 'Multiple CPU threads are unavailable in this browser; using one thread.';
}
$('backend').addEventListener('change',updateThreadControls);
$('threads').addEventListener('change',()=>{
  try {localStorage.setItem('rootfm-cpu-threads',$('threads').value);} catch { /* The selected setting still applies. */ }
  updateThreadControls();
});

async function initialize() {
  setBusy(false);
  const [,isolation]=await Promise.all([checkGpu(),prepareCpuThreads()]);
  if(isolation.reloading)return;
  threadingAvailable=isolation.available;
  booting=false;setBusy(false);
}

function addItem(item) {
  if(queue.some(q=>q.key===item.key)) return;
  queue.push({...item,id:crypto.randomUUID(),state:'Queued',result:null,mask:null,width:item.width||null,height:item.height||null});
}
function addFiles(files) {
  if(booting||busy||exporting) return;
  for(const file of files) addItem({name:file.name,file,key:`file:${file.name}:${file.size}:${file.lastModified}`});
  $('files').value=''; renderQueue();
}
$('files').addEventListener('change',e=>addFiles(e.target.files));
$('samples').addEventListener('click',async()=>{
  try {
    const response=await fetch(new URL('../samples.json',import.meta.url));
    if(!response.ok) throw new Error(`Test manifest could not load (${response.status}).`);
    const samples=await response.json();
    if(booting||busy||exporting)return;
    for(const item of samples) addItem({...item,key:`sample:${item.name}`,url:new URL(item.url,document.baseURI).href});
    renderQueue();
  } catch(e) { showNotice(e.message); }
});
for(const type of ['dragenter','dragover']) $('drop-zone').addEventListener(type,e=>{e.preventDefault();if(!busy)$('drop-zone').classList.add('dragging');});
for(const type of ['dragleave','drop']) $('drop-zone').addEventListener(type,e=>{e.preventDefault();$('drop-zone').classList.remove('dragging');});
$('drop-zone').addEventListener('drop',e=>addFiles(e.dataTransfer.files));
$('clear').addEventListener('click',()=>{
  if(busy||exporting)return;
  clearPreview();queue.length=0;batch=null;renderQueue();
  $('summary-section').hidden=true;$('progress-section').hidden=true;
});

function cell(row,text,className='') { const td=document.createElement('td');td.textContent=text;td.className=className;row.append(td);return td; }
function action(parent,text,fn,disabled=false) { const b=document.createElement('button');b.className='secondary';b.textContent=text;b.disabled=disabled;b.addEventListener('click',fn);parent.append(b);return b; }
function renderQueue() {
  $('queue').replaceChildren();
  for(const item of queue) {
    const row=document.createElement('tr');row.dataset.id=item.id;
    cell(row,item.name);
    cell(row,item.width?`${item.width} × ${item.height}`:'-','numeric');
    const state=cell(row,item.state,item.error?'error':'');state.title=item.error||'';
    cell(row,item.result?String(item.result.tiles.length):(item.tileProgress|| (item.tileCount?String(item.tileCount):'-')),'numeric');
    cell(row,item.result?seconds(item.result.imageMs):'-','numeric');
    cell(row,item.result?tileSeconds(item.result.timing.meanMs):'-','numeric');
    const actions=cell(row,'');actions.className='row-actions';
    if(item.result) {
      action(actions,'View',()=>showPreview(item),busy||exporting);
      action(actions,'Mask PNG',()=>downloadMask(item),busy||exporting);
    } else if(!busy) {
      if(!item.error) action(actions,'Preview',()=>showPreview(item),exporting);
      action(actions,'Remove',()=>{if(selected===item)clearPreview();queue.splice(queue.indexOf(item),1);renderQueue();},exporting);
    }
    $('queue').append(row);
  }
  $('queue-section').hidden=!queue.length;
  $('queue-count').textContent=queue.length?`${queue.length} image${queue.length===1?'':'s'}`:'No images added';
  $('run').disabled=booting||busy||exporting||!queue.length;
  $('clear').disabled=booting||busy||exporting||!queue.length;
  $('download-all').disabled=busy||exporting||!queue.some(q=>q.mask);
}
function updateRow(item) {
  const row=$('queue').querySelector(`[data-id="${item.id}"]`);
  if(!row) return;
  row.cells[2].textContent=item.state;row.cells[3].textContent=item.tileProgress||String(item.tileCount||'-');
}
function setBusy(value) {
  busy=value;
  for(const id of ['files','samples','backend','export-stats']) $(id).disabled=booting||busy||exporting;
  $('cancel').hidden=!value;
  updateThreadControls();
  renderQueue();
}
function showNotice(message) {
  $('progress-section').hidden=false;$('status').textContent=message;$('status').classList.add('error');
}
function progress(value,total) {
  if(!total) { $('progress').removeAttribute('value');$('percentage').textContent='';return; }
  $('progress').max=total;$('progress').value=value;$('percentage').textContent=`${Math.floor(100*value/total)}%`;
}

$('run').addEventListener('click',()=>{
  if(booting||busy||exporting||!queue.length)return;
  clearPreview(); worker?.terminate();
  for(const item of queue) {item.result=null;item.mask=null;item.error=null;item.state='Queued';item.tileProgress=null;}
  batch={started:performance.now(),startedAt:new Date().toISOString(),backend:$('backend').value,
    threadSetting:$('backend').value==='wasm'?$('threads').value:'1',threads:null,tiles:[],completedTiles:0,totalTiles:0};
  $('summary-section').hidden=true;$('progress-section').hidden=false;$('status').classList.remove('error');
  $('batch-export-status').textContent='';
  $('status').textContent='Preparing files…';$('progress-detail').textContent='Reading image dimensions';progress(0,0);
  setBusy(true);
  timer=setInterval(()=>$('elapsed').textContent=seconds(performance.now()-batch.started),100);
  worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
  worker.onerror=e=>finish('failed',e.message||'The processing worker stopped unexpectedly.');
  worker.onmessage=({data})=>handleMessage(data);
  worker.postMessage({type:'run',backend:batch.backend,threadSetting:batch.threadSetting,items:queue.map(({id,name,file,url,width,height})=>({id,name,file,url,width,height}))});
});

function handleMessage(data) {
  if(!busy)return;
  const item=queue.find(q=>q.id===data.id);
  switch(data.type) {
    case 'preflight':
      item.state='Preparing';updateRow(item);$('status').textContent=`Preparing image ${data.index} of ${data.count}: ${item.name}`;break;
    case 'image-ready':
      Object.assign(item,{width:data.width,height:data.height,tileCount:data.tiles,state:'Queued'});renderQueue();break;
    case 'model-progress':
      $('status').textContent=data.cacheHit?'Reading cached model…':'Downloading model…';
      $('progress-detail').textContent=`${mib(data.loadedBytes)}${data.totalBytes?` / ${mib(data.totalBytes)}`:''}`;
      progress(data.loadedBytes,data.totalBytes);break;
    case 'session-loading':
      $('status').textContent=`Initializing ${modeNames[batch.backend]}…`;$('progress-detail').textContent='Creating inference session';progress(0,0);break;
    case 'started':
      Object.assign(batch,data);batch.tiles=[];progress(0,data.totalTiles);
      if(data.threadWarning)$('thread-info').textContent=data.threadWarning;
      break;
    case 'image-start':
      item.state='Processing';updateRow(item);$('status').textContent=`Processing ${item.name}`;
      $('progress-detail').textContent=`${data.completedTiles} / ${data.totalTiles} tiles`;break;
    case 'tile':
      item.tileProgress=`${data.completed} / ${data.count}`;updateRow(item);
      batch.tiles.push({...data.timing,imageId:item.id});batch.completedTiles=data.completedTiles;batch.totalTiles=data.totalTiles;
      progress(data.completedTiles,data.totalTiles);
      $('progress-detail').textContent=`${data.completedTiles} / ${data.totalTiles} tiles · current image ${data.completed} / ${data.count} · last tile ${tileSeconds(data.timing.totalMs)}`;break;
    case 'image-complete':
      item.result=data.result;item.mask=new Uint8Array(data.mask);item.state='Complete';renderQueue();break;
    case 'image-error':
      item.error=data.error;item.state=`Failed: ${data.error}`;renderQueue();break;
    case 'done':
      Object.assign(batch,data);finish(queue.some(q=>q.error)?'partial':'complete');break;
    case 'fatal':finish('failed',data.error);break;
  }
}

function finish(outcome,message) {
  if(!busy)return;
  clearInterval(timer);worker?.terminate();worker=null;
  batch.totalMs=performance.now()-batch.started;batch.outcome=outcome;
  for(const item of queue) if(['Queued','Preparing','Processing'].includes(item.state)) item.state=outcome==='cancelled'?'Cancelled':'Not completed';
  const done=queue.filter(q=>q.result);
  $('elapsed').textContent=seconds(batch.totalMs);
  $('status').textContent=message||({complete:'Batch complete.',partial:'Batch finished with image errors. See the list below.',cancelled:'Batch cancelled. Completed masks are still available.'}[outcome]||'Batch stopped.');
  $('status').classList.toggle('error',['failed','partial'].includes(outcome));
  if(outcome==='complete') progress(batch.totalTiles,batch.totalTiles);
  else if(!batch.totalTiles) progress(0,1);
  $('progress-detail').textContent=`${done.length} / ${queue.length} images completed · ${batch.completedTiles} / ${batch.totalTiles} tiles processed`;
  $('total-time').textContent=seconds(batch.totalMs);
  $('image-time').textContent=done.length?seconds(done.reduce((s,q)=>s+q.result.imageMs,0)/done.length):'-';
  $('tile-time').textContent=batch.tiles.length?tileSeconds(batch.tiles.reduce((s,t)=>s+t.totalMs,0)/batch.tiles.length):'-';
  $('completed').textContent=`${done.length} / ${queue.length}`;
  const threadLabel=batch.threads?`${batch.threads} WASM thread${batch.threads===1?'':'s'}${batch.threadSetting==='auto'?' (Auto)':''}`:'WASM threads not initialized';
  $('setup-time').textContent=`${modeNames[batch.backend]} · FP32 · ${threadLabel} · file preparation ${seconds(batch.preflightMs||0)} · model load ${seconds(batch.modelLoadMs||0)}${batch.model?.cacheHit?' (cached)':''} · session initialization ${seconds(batch.sessionInitMs||0)}`;
  $('summary-section').hidden=false;setBusy(false);
  if(batch.threadWarning)$('thread-info').textContent=batch.threadWarning;
}
$('cancel').addEventListener('click',()=>finish('cancelled'));

function statsReport() {
  const {started,tiles,type,...metadata}=batch;
  const completed=queue.filter(q=>q.result);
  return {schemaVersion:1,...metadata,runtime:'onnxruntime-web 1.30.0',userAgent:navigator.userAgent,
    aggregate:{completedImages:completed.length,imageCount:queue.length,
      meanImageMs:completed.length?completed.reduce((s,q)=>s+q.result.imageMs,0)/completed.length:null,
      meanTileMs:tiles.length?tiles.reduce((s,t)=>s+t.totalMs,0)/tiles.length:null},
    tileSize:1024,maskConvention:'roots=white (1), background=black (0); 1-bit grayscale PNG',
    timingDefinitions:{totalMs:'Batch wall time, including file preparation and model setup; excludes PNG export.',imageMs:'Image fetch/read, decode, all tile work, and foreground counting.',totalTileMs:'Pixel preparation, session.run plus output readback, and mask stitching. First tile is included; no hidden warmup.'},
    processedTileTimings:tiles,
    images:queue.map(({name,state,width,height,result,error})=>({name,state,width,height,result,error})),
    exports:batch.exports||[]};
}
function save(blob,name) {
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
$('export-stats').addEventListener('click',()=>save(new Blob([JSON.stringify(statsReport(),null,2)],{type:'application/json'}),'rootfm-benchmark.json'));

function clearPreview() {
  previewVersion++;selected=null;previewBitmap?.close();previewBitmap=null;previewMask=null;
  $('preview-section').hidden=true;$('preview').width=1;$('preview').height=1;$('export-status').textContent='';
}
$('close-preview').addEventListener('click',clearPreview);

async function showPreview(item) {
  if(busy)return;
  clearPreview();const version=previewVersion;selected=item;
  $('preview-section').hidden=false;$('preview-caption').textContent=`Loading preview of ${item.name}…`;
  $('download-mask').hidden=!item.mask;
  $('preview-mode').disabled=!item.mask;
  $('preview-mode').value=item.mask?'overlay':'original';
  try {
    const blob=item.file || await (await fetch(item.url)).blob();
    const bitmap=await createImageBitmap(blob,{imageOrientation:'from-image',colorSpaceConversion:'none',resizeWidth:Math.min(1200,item.width||1200),resizeQuality:'high'});
    if(version!==previewVersion) {bitmap.close();return;}
    previewBitmap=bitmap;
    // Pool foreground pixels so thin roots remain visible in a reduced preview.
    if(item.mask) {
      previewMask=new ImageData(bitmap.width,bitmap.height);
      const p=previewMask.data;
      for(let y=0;y<item.height;y++) {
        const py=Math.floor(y*bitmap.height/item.height);
        for(let x=0;x<item.width;x++) if(maskPixel(item.mask,item.width,x,y)) {
          const i=(py*bitmap.width+Math.floor(x*bitmap.width/item.width))*4;
          p[i]=55;p[i+1]=223;p[i+2]=138;p[i+3]=255;
        }
      }
    }
    $('preview-caption').textContent=`${item.name}${item.width?` · ${item.width} × ${item.height}`:''} · reduced preview${item.mask?` · roots cover ${item.result.foregroundPercent.toFixed(3)}% of pixels`:''}`;
    drawPreview();
  } catch(e) { if(version===previewVersion)$('preview-caption').textContent=`Preview failed: ${e.message}`; }
}

function drawPreview() {
  if(!previewBitmap)return;
  const canvas=$('preview');canvas.width=previewBitmap.width;canvas.height=previewBitmap.height;
  const ctx=canvas.getContext('2d');const mode=$('preview-mode').value;
  ctx.drawImage(previewBitmap,0,0);
  if(previewMask && mode==='mask') {
    const out=new ImageData(canvas.width,canvas.height);
    for(let i=0;i<out.data.length;i+=4) {const v=previewMask.data[i+3]?255:0;out.data[i]=v;out.data[i+1]=v;out.data[i+2]=v;out.data[i+3]=255;}
    ctx.putImageData(out,0,0);
  } else if(previewMask && mode==='overlay') {
    const overlay=new OffscreenCanvas(canvas.width,canvas.height);overlay.getContext('2d').putImageData(previewMask,0,0);
    ctx.globalAlpha=Number($('opacity').value);ctx.drawImage(overlay,0,0);ctx.globalAlpha=1;
  }
}
$('preview-mode').addEventListener('change',drawPreview);$('opacity').addEventListener('input',drawPreview);

async function downloadMask(item) {
  if(busy||exporting||!item?.mask)return;
  exporting=true;setBusy(false);
  const started=performance.now();
  $('export-status').textContent=`Encoding ${item.name}…`;
  $('download-mask').disabled=true;
  try {
    const blob=await maskPng(item.mask,item.width,item.height);
    save(blob,item.name.replace(/\.[^.]+$/,'')+'_mask.png');
    const exportMs=performance.now()-started;
    (batch.exports??=[]).push({name:item.name,exportMs,bytes:blob.size});
    $('export-status').textContent=`Mask encoded in ${seconds(exportMs)} · ${mib(blob.size)} · ${item.width} × ${item.height}`;
  } catch(e) {showNotice(`Mask export failed: ${e.message}`);}
  finally {exporting=false;$('download-mask').disabled=false;setBusy(false);}
}
$('download-mask').addEventListener('click',()=>downloadMask(selected));

$('download-all').addEventListener('click',async()=>{
  const items=queue.filter(item=>item.mask);
  if(busy||exporting||!items.length)return;
  exporting=true;setBusy(false);$('download-mask').disabled=true;
  const started=performance.now(),names=uniqueMaskNames(items.map(item=>item.name));
  async function* files() {
    for(let i=0;i<items.length;i++) {
      $('batch-export-status').textContent=`Encoding mask ${i+1} / ${items.length}: ${items[i].name}`;
      yield {name:names[i],blob:await maskPng(items[i].mask,items[i].width,items[i].height)};
    }
  }
  try {
    const blob=await storedZip(files());
    save(blob,'rootfm-masks.zip');
    const exportMs=performance.now()-started;
    (batch.exports??=[]).push({name:'rootfm-masks.zip',imageCount:items.length,exportMs,bytes:blob.size});
    $('batch-export-status').textContent=`ZIP ready: ${items.length} ${items.length===1?'mask':'masks'} · ${mib(blob.size)} · encoded in ${seconds(exportMs)}`;
  } catch(e) {$('batch-export-status').textContent=`ZIP export failed: ${e.message}`;}
  finally {exporting=false;$('download-mask').disabled=false;setBusy(false);}
});

initialize();
