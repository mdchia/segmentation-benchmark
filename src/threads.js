export function cpuThreadCount(setting,hardwareConcurrency=1) {
  if(setting==='auto')return Math.min(8,Math.ceil(Math.max(1,hardwareConcurrency||1)/2));
  if(!['1','2','4','8'].includes(String(setting)))throw new Error('Invalid CPU thread setting.');
  return Number(setting);
}

// One wide thread pool scales poorly on this graph. On an 8-core laptop, Auto's
// eight threads processed tiles 11% faster as four 2-thread sessions (6% for
// three at six threads, 2.5% for two at four). Each session holds its own
// weights and activations (about 500 MiB), so small budgets and devices that
// report under 8 GB keep one session. Explicit settings always use one session.
// A 2-thread session takes about 3.5 times as long per tile, so batches need
// about six tiles per session before the pool finishes sooner.
export const TILES_PER_SESSION=6;
export function cpuSessionPlan(setting,hardwareConcurrency=1,deviceMemory,threaded=true,tiles=Infinity) {
  const threads=cpuThreadCount(setting,hardwareConcurrency);
  const sessions=Math.floor(threads/2);
  if(setting==='auto'&&threaded&&threads>=6&&!(deviceMemory<8)&&tiles>=sessions*TILES_PER_SESSION) {
    return {sessions,threadsPerSession:2,threads:sessions*2};
  }
  return {sessions:1,threadsPerSession:threaded?threads:1,threads:threaded?threads:1};
}

export function supportsCpuThreads() {
  return globalThis.crossOriginIsolated===true&&typeof SharedArrayBuffer!=='undefined';
}

function waitForController(url) {
  return new Promise(resolve=>{
    let timer;
    const done=value=>{clearTimeout(timer);navigator.serviceWorker.removeEventListener('controllerchange',check);resolve(value);};
    const check=()=>{if(navigator.serviceWorker.controller?.scriptURL===url)done(true);};
    navigator.serviceWorker.addEventListener('controllerchange',check);
    timer=setTimeout(()=>done(false),8000);
    check();
  });
}

export async function prepareCpuThreads() {
  const attemptKey='rootfm-isolation-reload-v1';
  let attempted=false;
  try {attempted=sessionStorage.getItem(attemptKey)==='1';sessionStorage.removeItem(attemptKey);} catch { /* Single-thread fallback remains available. */ }
  if(!globalThis.isSecureContext||!('crossOriginIsolated' in globalThis)||!navigator.serviceWorker)return {available:supportsCpuThreads()};
  try {
    const url=new URL('../isolation-worker.js',import.meta.url).href;
    const registration=await navigator.serviceWorker.register(url,{scope:new URL('../',import.meta.url).href,updateViaCache:'none'});
    // Existing isolated pages stay interactive when a newer worker is installed.
    if(supportsCpuThreads())return {available:true};
    if(attempted)return {available:false};
    if(!registration.active&&!registration.installing&&!registration.waiting)return {available:false};
    if(!await waitForController(url))return {available:false};
    // Reload once, before file input is enabled. A marker prevents reload loops.
    sessionStorage.setItem(attemptKey,'1');
    location.reload();
    return {available:false,reloading:true};
  } catch {return {available:supportsCpuThreads()};}
}
