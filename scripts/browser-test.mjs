import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { cpuSessionPlan } from '../src/threads.js';

const full=process.argv.includes('--full');
const root=new URL('../',import.meta.url).pathname;
const out=new URL('../test-results/',import.meta.url).pathname;
await mkdir(out,{recursive:true});
const server=spawn(process.execPath,['scripts/serve.mjs','--no-build'],{cwd:root,env:{...process.env,PORT:'5174',BASE_PATH:'/segmentation-benchmark/'},stdio:['ignore','pipe','inherit']});
await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('exit',code=>reject(new Error(`Test server exited: ${code}`)));});
const browser=await chromium.launch({headless:true,channel:'chromium',args:['--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--ignore-gpu-blocklist']});
const page=await browser.newPage({viewport:{width:1280,height:1000},acceptDownloads:true});
const errors=[];
page.on('pageerror',e=>{errors.push(e.message);console.log('Page error:',e.message);});
page.on('console',msg=>{if(msg.type()==='error')console.log('Browser:',msg.text().slice(0,300));});
let lastStatus='';
const monitor=setInterval(async()=>{
  try{const s=await page.locator('#progress-detail').textContent();if(s!==lastStatus){console.log(s);lastStatus=s;}}catch{}
},15000);
async function download(selector,name) {
  const event=page.waitForEvent('download');await page.locator(selector).click();const d=await event;await d.saveAs(out+name);return out+name;
}
try {
  await page.goto('http://localhost:5174/segmentation-benchmark/');
  await page.waitForFunction(()=>!document.querySelector('#files').disabled,null,{timeout:25000});
  assert.equal(await page.evaluate(()=>crossOriginIsolated),true);
  assert.deepEqual(await page.locator('#threads option').allTextContents(),['Auto','1','2','4','8']);
  await page.selectOption('#theme','dark');
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.reload();await page.waitForFunction(()=>!document.querySelector('#files').disabled);
  assert.equal(await page.locator('#theme').inputValue(),'dark');
  await page.selectOption('#theme','light');
  await page.screenshot({path:out+'initial.png',fullPage:true});
  // Real photo crops: one small padded image and one image crossing tile edges.
  const crops=await page.evaluate(async()=>{
    const image=await createImageBitmap(await(await fetch('./test-data/2025-07-24_Box053.JPG')).blob(),{imageOrientation:'from-image',colorSpaceConversion:'none'});
    const result=[];
    for(const [name,w,h] of [['small.png',513,385],['edges.png',1025,1027]]) {
      const canvas=new OffscreenCanvas(w,h);canvas.getContext('2d').drawImage(image,1700,3000,w,h,0,0,w,h);
      result.push({name,bytes:Array.from(new Uint8Array(await(await canvas.convertToBlob()).arrayBuffer()))});
    }
    image.close();return result;
  });
  for(const crop of crops)await writeFile(out+crop.name,Buffer.from(crop.bytes));
  await page.setInputFiles('#files',crops.map(c=>({name:c.name,mimeType:'image/png',buffer:Buffer.from(c.bytes)})));
  await page.waitForFunction(()=>document.querySelectorAll('#queue tr').length===2);
  assert.equal(await page.locator('#queue tr').count(),2);
  await page.selectOption('#backend','wasm');await page.selectOption('#threads','4');await page.click('#run');
  await page.locator('#cancel').waitFor();
  assert.equal(await page.locator('#preview-section').isHidden(),true);
  await page.selectOption('#theme','dark');assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.waitForFunction(()=>document.querySelector('#cancel').hidden,null,{timeout:180000});
  assert.equal(await page.locator('#status').textContent(),'Batch complete.');
  assert.equal(await page.locator('#completed').textContent(),'2 / 2');
  await download('#export-stats','cpu-stats.json');
  const cpuStats=JSON.parse(await readFile(out+'cpu-stats.json','utf8'));
  assert.equal(cpuStats.threads,4);assert.equal(cpuStats.requestedThreads,4);assert.equal(cpuStats.crossOriginIsolated,true);
  assert.match(await page.locator('#setup-time').textContent(),/4 WASM threads/);
  for(let i=0;i<2;i++)await download(`#queue tr:nth-child(${i+1}) button:nth-child(2)`,`cpu-${crops[i].name}`);
  await download('#download-all','cpu-masks.zip');
  assert.match(await page.locator('#batch-export-status').textContent(),/2 masks/);
  await page.locator('#queue tr').first().getByRole('button',{name:'View',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#preview').width>1);
  await page.selectOption('#preview-mode','mask');
  await page.screenshot({path:out+'cpu-result-dark.png',fullPage:true});
  await page.selectOption('#theme','light');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:out+'mobile.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.setViewportSize({width:1280,height:1000});
  // Every menu setting must reach a real inference session and preserve its mask.
  const cpuMask=await readFile(out+`cpu-${crops[0].name}`);
  for(const setting of ['1','2','8','auto']) {
    await page.click('#clear');
    await page.setInputFiles('#files',{name:crops[0].name,mimeType:'image/png',buffer:Buffer.from(crops[0].bytes)});
    await page.selectOption('#threads',setting);await page.click('#run');
    await page.waitForFunction(()=>document.querySelector('#cancel').hidden,null,{timeout:180000});
    assert.equal(await page.locator('#status').textContent(),'Batch complete.');
    await download('#export-stats',`cpu-threads-${setting}.json`);
    const stats=JSON.parse(await readFile(out+`cpu-threads-${setting}.json`,'utf8'));
    const expected=setting==='auto'?Math.min(8,Math.ceil(stats.hardwareConcurrency/2)):Number(setting);
    assert.equal(stats.threads,expected);assert.equal(stats.threadSetting,setting);
    const plan=cpuSessionPlan(setting,stats.hardwareConcurrency,stats.deviceMemory??undefined,true,stats.totalTiles);
    assert.equal(stats.sessions,plan.sessions);assert.equal(stats.threadsPerSession,plan.threadsPerSession);
    const mask=await readFile(await download('#queue tr:first-child button:nth-child(2)',`cpu-threads-${setting}.png`));
    assert.deepEqual(mask,cpuMask,`CPU mask changed with the ${setting} thread setting.`);
    console.log(`CPU ${setting}: ${stats.threads} threads in ${stats.sessions} session(s), ${stats.totalMs.toFixed(0)} ms`);
  }
  // A 24-tile crop is large enough for Auto's parallel sessions; their mask must match one session.
  let parallelMask;
  for(const setting of ['8','auto']) {
    await page.click('#clear');
    await page.evaluate(async()=>{
      const image=await createImageBitmap(await(await fetch('./test-data/2025-07-24_Box053.JPG')).blob(),{imageOrientation:'from-image',colorSpaceConversion:'none'});
      const canvas=new OffscreenCanvas(4096,6144);canvas.getContext('2d').drawImage(image,0,0,4096,6144,0,0,4096,6144);image.close();
      const files=new DataTransfer();files.items.add(new File([await canvas.convertToBlob()],'parallel.png',{type:'image/png'}));
      const input=document.querySelector('#files');input.files=files.files;input.dispatchEvent(new Event('change'));
    });
    await page.waitForFunction(()=>document.querySelectorAll('#queue tr').length===1);
    await page.selectOption('#threads',setting);await page.click('#run');
    await page.waitForFunction(()=>document.querySelector('#cancel').hidden,null,{timeout:300000});
    assert.equal(await page.locator('#status').textContent(),'Batch complete.');
    await download('#export-stats',`cpu-parallel-${setting}.json`);
    const stats=JSON.parse(await readFile(out+`cpu-parallel-${setting}.json`,'utf8'));
    assert.equal(stats.totalTiles,24);
    const plan=cpuSessionPlan(setting,stats.hardwareConcurrency,stats.deviceMemory??undefined,true,stats.totalTiles);
    assert.equal(stats.sessions,plan.sessions);assert.equal(stats.threads,plan.threads);
    const mask=await readFile(await download('#queue tr:first-child button:nth-child(2)',`cpu-parallel-${setting}.png`));
    if(parallelMask)assert.deepEqual(mask,parallelMask,'CPU mask changed with parallel Auto sessions.');
    parallelMask=mask;
    console.log(`CPU ${setting}, 24 tiles: ${stats.threads} threads in ${stats.sessions} session(s), ${stats.totalMs.toFixed(0)} ms`);
  }
  const gpuAvailable=await page.evaluate(()=>!document.querySelector('#backend option[value="webgpu"]').disabled);
  if(gpuAvailable) {
    await page.click('#clear');
    if(full) await page.click('#samples');
    else await page.setInputFiles('#files',crops.map(c=>({name:c.name,mimeType:'image/png',buffer:Buffer.from(c.bytes)})));
    await page.waitForFunction(n=>document.querySelectorAll('#queue tr').length===n,full?8:2);
    await page.selectOption('#backend','webgpu');assert.equal(await page.locator('#threads').isDisabled(),true);await page.click('#run');
    await page.waitForFunction(()=>document.querySelector('#cancel').hidden,null,{timeout:900000});
    assert.equal(await page.locator('#status').textContent(),'Batch complete.');
    await download('#export-stats','gpu-stats.json');
    assert.equal(JSON.parse(await readFile(out+'gpu-stats.json','utf8')).threads,1);
    await download('#queue tr:first-child button:nth-child(2)','gpu-mask.png');
    if(full)await download('#download-all','gpu-masks.zip');
    await page.locator('#queue tr').first().getByRole('button',{name:'View',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#preview').width>1);
    await page.screenshot({path:out+'gpu-result.png',fullPage:true});
    console.log('WebGPU:',await page.locator('#completed').textContent(),await page.locator('#total-time').textContent());
    // Recreate the worker and session each time to catch changes during weight upload.
    await page.click('#clear');
    await page.setInputFiles('#files',{name:crops[1].name,mimeType:'image/png',buffer:Buffer.from(crops[1].bytes)});
    let previous;
    for(let i=0;i<2;i++) {
      await page.click('#run');
      await page.waitForFunction(()=>document.querySelector('#cancel').hidden,null,{timeout:180000});
      assert.equal(await page.locator('#status').textContent(),'Batch complete.');
      const mask=await readFile(await download('#queue tr:first-child button:nth-child(2)','gpu-repeat-edges.png'));
      if(previous) assert.deepEqual(mask,previous,'WebGPU edge-crop mask changed between sessions.');
      previous=mask;
    }
  } else console.log('WebGPU unavailable in this test browser; GPU inference not tested.');
  await page.click('#clear');await page.click('#samples');
  await page.waitForFunction(()=>document.querySelectorAll('#queue tr').length===8);
  await page.selectOption('#backend','wasm');await page.click('#run');await page.click('#cancel');
  assert.match(await page.locator('#status').textContent(),/cancelled/);
  assert.equal(await page.locator('#run').isEnabled(),true);
  // A decode failure must be visible without preventing another valid image.
  await page.click('#clear');
  await page.setInputFiles('#files',[{name:'broken.png',mimeType:'image/png',buffer:Buffer.from('not an image')},{name:'small.png',mimeType:'image/png',buffer:Buffer.from(crops[0].bytes)}]);
  await page.click('#run');await page.waitForFunction(()=>document.querySelector('#cancel').hidden,null,{timeout:180000});
  assert.match(await page.locator('#status').textContent(),/image errors/);
  assert.equal(await page.locator('#completed').textContent(),'1 / 2');
  await download('#download-all','partial-masks.zip');
  assert.match(await page.locator('#batch-export-status').textContent(),/1 mask/);
  assert.deepEqual(errors,[]);
  // Browsers without service workers must still run the model with one thread.
  const fallback=await browser.newContext({serviceWorkers:'block'});
  await fallback.addInitScript(()=>Object.defineProperty(navigator,'serviceWorker',{value:undefined}));
  const fallbackPage=await fallback.newPage();
  await fallbackPage.goto('http://127.0.0.1:5174/segmentation-benchmark/');
  await fallbackPage.waitForFunction(()=>!document.querySelector('#files').disabled);
  await fallbackPage.selectOption('#backend','wasm');
  assert.equal(await fallbackPage.evaluate(()=>document.querySelector('#threads option[value="4"]').disabled),true);
  assert.match(await fallbackPage.locator('#thread-info').textContent(),/one thread/);
  await fallbackPage.setInputFiles('#files',{name:crops[0].name,mimeType:'image/png',buffer:Buffer.from(crops[0].bytes)});
  await fallbackPage.click('#run');await fallbackPage.waitForFunction(()=>document.querySelector('#cancel').hidden,null,{timeout:180000});
  assert.equal(await fallbackPage.locator('#status').textContent(),'Batch complete.');
  assert.match(await fallbackPage.locator('#setup-time').textContent(),/1 WASM thread/);
  await fallback.close();
  console.log('Passed CPU batch, edge tiles, padding, PNG and ZIP exports, previews, theme, mobile layout, cancellation, error recovery, and repository subpath checks.');
} catch(e) {
  console.log('Failure state:',await page.evaluate(()=>({status:document.querySelector('#status').textContent,files:document.querySelector('#files').files.length,rows:document.querySelector('#queue').innerHTML,scripts:[...document.scripts].map(s=>s.src)})));
  await page.screenshot({path:out+'failure.png',fullPage:true});throw e;
} finally { clearInterval(monitor);await browser.close();server.kill('SIGTERM'); }
