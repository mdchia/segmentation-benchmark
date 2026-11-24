import { cp, mkdir, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ORT_VERSION, MODEL_FILE, MODEL_SHA256 } from '../src/core.js';
import { optimizeModel } from './optimize-model.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const dist=new URL('../dist/',import.meta.url);
const originalModel=await readFile(new URL('../models/rootfm_fp32.onnx',import.meta.url));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
if(sha256(originalModel)!=='ab9f6a97023599bf427ef9960e5fd81172fb7bca5e7a536b9eecd5246fe3125a') {
  throw new Error('Model checksum mismatch. Restore the supplied FP32 ONNX export.');
}
const model=optimizeModel(originalModel);
if(sha256(model)!==MODEL_SHA256) throw new Error('Optimized FP32 model checksum mismatch.');
await rm(dist,{recursive:true,force:true});await mkdir(dist,{recursive:true});
for(const path of ['licenses','isolation-worker.js']) await cp(new URL(`../${path}`,import.meta.url),new URL(path,dist),{recursive:true});
await mkdir(new URL('models/',dist));
await cp(new URL('../models/RootFM.bib',import.meta.url),new URL('models/RootFM.bib',dist));
await writeFile(new URL(`models/${MODEL_FILE}`,dist),model);
// Version the whole module directory so imports and workers update together.
const sourceHash=createHash('sha256');
for(const name of (await readdir(new URL('../src/',import.meta.url))).sort()) {
  sourceHash.update(name).update('\0').update(await readFile(new URL(`../src/${name}`,import.meta.url)));
}
const sourceDirectory=`src-${sourceHash.digest('hex').slice(0,12)}`;
const css=await readFile(new URL('../styles.css',import.meta.url));
const stylesheet=`styles-${createHash('sha256').update(css).digest('hex').slice(0,12)}.css`;
await cp(new URL('../src/',import.meta.url),new URL(sourceDirectory,dist),{recursive:true});
await writeFile(new URL(stylesheet,dist),css);
const html=(await readFile(new URL('../index.html',import.meta.url),'utf8'))
  .replace('./src/app.js',`./${sourceDirectory}/app.js`).replace('./styles.css',`./${stylesheet}`);
await writeFile(new URL('index.html',dist),html);
const runtimePackage=JSON.parse(await readFile(new URL('../node_modules/onnxruntime-web/package.json',import.meta.url),'utf8'));
if(runtimePackage.version!==ORT_VERSION) throw new Error('Installed ONNX Runtime does not match the app version.');
const vendor=new URL(`vendor-${ORT_VERSION}/`,dist);
await mkdir(vendor);
for(const name of ['ort.webgpu.min.mjs','ort.jspi.min.mjs','ort.wasm.min.mjs',
  'ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.mjs','ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs','ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.jspi.mjs','ort-wasm-simd-threaded.jspi.wasm']) {
  await cp(new URL(`../node_modules/onnxruntime-web/dist/${name}`,import.meta.url),new URL(name,vendor));
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
console.log(`Built ${root}dist with ${samples.length} test images and verified FP32 model (${model.byteLength} bytes).`);
