import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

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
  await page.locator('#capability').filter({hasText:/CPU/}).waitFor();
  await page.selectOption('#theme','dark');
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.reload();assert.equal(await page.locator('#theme').inputValue(),'dark');
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
  await page.selectOption('#backend','wasm');await page.click('#run');
  await page.locator('#cancel').waitFor();
  assert.equal(await page.locator('#preview-section').isHidden(),true);
  await page.selectOption('#theme','dark');assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.waitForFunction(()=>document.querySelector('#cancel').hidden,null,{timeout:180000});
  assert.equal(await page.locator('#status').textContent(),'Batch complete.');
  assert.equal(await page.locator('#completed').textContent(),'2 / 2');
  await download('#export-stats','cpu-stats.json');
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
  const gpuAvailable=!(await page.locator('#backend option[value="webgpu"]').isDisabled());
  if(gpuAvailable) {
    await page.click('#clear');
    if(full) await page.click('#samples');
    else await page.setInputFiles('#files',crops.map(c=>({name:c.name,mimeType:'image/png',buffer:Buffer.from(c.bytes)})));
    await page.waitForFunction(n=>document.querySelectorAll('#queue tr').length===n,full?8:2);
    await page.selectOption('#backend','webgpu');await page.click('#run');
    await page.waitForFunction(()=>document.querySelector('#cancel').hidden,null,{timeout:900000});
    assert.equal(await page.locator('#status').textContent(),'Batch complete.');
    await download('#export-stats','gpu-stats.json');
    await download('#queue tr:first-child button:nth-child(2)','gpu-mask.png');
    if(full)await download('#download-all','gpu-masks.zip');
    await page.locator('#queue tr').first().getByRole('button',{name:'View',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#preview').width>1);
    await page.screenshot({path:out+'gpu-result.png',fullPage:true});
    console.log('WebGPU:',await page.locator('#completed').textContent(),await page.locator('#total-time').textContent());
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
  console.log('Passed CPU batch, edge tiles, padding, PNG and ZIP exports, previews, theme, mobile layout, cancellation, error recovery, and repository subpath checks.');
} catch(e) {
  console.log('Failure state:',await page.evaluate(()=>({status:document.querySelector('#status').textContent,files:document.querySelector('#files').files.length,rows:document.querySelector('#queue').innerHTML,scripts:[...document.scripts].map(s=>s.src)})));
  await page.screenshot({path:out+'failure.png',fullPage:true});throw e;
} finally { clearInterval(monitor);await browser.close();server.kill('SIGTERM'); }
