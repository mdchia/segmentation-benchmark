import { cp, mkdir, rm, writeFile, readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MODEL_SHA256 } from '../src/core.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const dist=new URL('../dist/',import.meta.url);
const model=new URL('../models/rootfm_fp32.onnx',import.meta.url);
const digest=createHash('sha256').update(await readFile(model)).digest('hex');
if(digest!==MODEL_SHA256) throw new Error('Model checksum mismatch. Restore the supplied FP32 ONNX export.');
await rm(dist,{recursive:true,force:true});await mkdir(dist,{recursive:true});
for(const path of ['index.html','styles.css','src','licenses','models']) await cp(new URL(`../${path}`,import.meta.url),new URL(path,dist),{recursive:true});
await mkdir(new URL('vendor/',dist));
for(const name of ['ort.webgpu.min.mjs',
  'ort-wasm-simd-threaded.jsep.mjs','ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs','ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.jspi.mjs','ort-wasm-simd-threaded.jspi.wasm']) {
  await cp(new URL(`../node_modules/onnxruntime-web/dist/${name}`,import.meta.url),new URL(`vendor/${name}`,dist));
}
await mkdir(new URL('test-data/',dist));
const samples=[];
for(const name of (await readdir(new URL('../test-data/',import.meta.url))).sort()) {
  if(!/\.(jpg|jpeg|png|webp)$/i.test(name)) continue;
  await cp(new URL(`../test-data/${name}`,import.meta.url),new URL(`test-data/${name}`,dist));
  // Supplied JPEGs are 8192 x 5464 with EXIF orientation 8 (rotated portrait).
  // Custom files are decoded in preflight; these dimensions are only for this known set.
  const known=/^2025-07-24_Box0(5[3-9]|60)\.JPG$/.test(name);
  samples.push({name,url:`./test-data/${name}`,...(known?{width:5464,height:8192}:{})});
}
await writeFile(new URL('samples.json',dist),JSON.stringify(samples,null,2)+'\n');
await writeFile(new URL('.nojekyll',dist),'');
console.log(`Built ${root}dist with ${samples.length} test images and verified FP32 model (${(await stat(model)).size} bytes).`);
