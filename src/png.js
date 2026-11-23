// Grayscale, one-bit PNG. Streams packed rows to avoid a full-resolution canvas.
const crcTable = Uint32Array.from({length:256}, (_, n) => {
  let c = n;
  for (let k=0; k<8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function u32(n) { const b=new Uint8Array(4); new DataView(b.buffer).setUint32(0,n); return b; }
function chunk(type, data) {
  const name = new TextEncoder().encode(type);
  let crc=0xffffffff;
  for (const part of [name,data]) for (const b of part) crc=crcTable[(crc^b)&255]^(crc>>>8);
  return [u32(data.length),name,data,u32((crc^0xffffffff)>>>0)];
}

export async function maskPng(mask, width, height) {
  const rowBytes=Math.ceil(width/8);
  if (mask.length !== rowBytes*height) throw new Error('Mask dimensions do not match its data.');
  let y=0;
  const source=new ReadableStream({ pull(controller) {
    if (y===height) { controller.close(); return; }
    const rows=Math.min(64,height-y);
    const bytes=new Uint8Array((rowBytes+1)*rows);
    for (let r=0;r<rows;r++,y++) {
      const dest=r*(rowBytes+1)+1;
      for(let x=0;x<rowBytes;x++) bytes[dest+x]=mask[y*rowBytes+x];
    }
    controller.enqueue(bytes);
  }});
  const header=new Uint8Array(13);
  const view=new DataView(header.buffer);
  view.setUint32(0,width); view.setUint32(4,height);
  header[8]=1;
  const parts=[new Uint8Array([137,80,78,71,13,10,26,10]),...chunk('IHDR',header)];
  const reader=source.pipeThrough(new CompressionStream('deflate')).getReader();
  while(true) {
    const {value,done}=await reader.read();
    if(done) break;
    parts.push(...chunk('IDAT',value));
  }
  parts.push(...chunk('IEND',new Uint8Array()));
  return new Blob(parts,{type:'image/png'});
}
