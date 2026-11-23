import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

if(!process.argv.includes('--no-build')) await import('./build.mjs');
const root=fileURLToPath(new URL('../dist/',import.meta.url));
const port=Number(process.env.PORT||5173);
const base=process.env.BASE_PATH||'/';
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.wasm':'application/wasm','.onnx':'application/octet-stream','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.txt':'text/plain; charset=utf-8'};
const server=createServer(async(req,res)=>{
  try {
    let path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(!path.startsWith(base)){res.writeHead(404);res.end('Not found');return;}
    path=path.slice(base.length);
    const file=resolve(root,path||'index.html');
    if(!file.startsWith(resolve(root)+sep)){res.writeHead(403);res.end('Forbidden');return;}
    const info=await stat(file);
    if(!info.isFile())throw new Error('Not a file');
    const ext=file.slice(file.lastIndexOf('.')).toLowerCase();
    res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Content-Length':info.size,'Cache-Control':'no-cache'});
    if(req.method==='HEAD')res.end();else createReadStream(file).pipe(res);
  }catch{res.writeHead(404);res.end('Not found');}
});
server.listen(port,'127.0.0.1',()=>console.log(`Local: http://localhost:${port}${base}`));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
