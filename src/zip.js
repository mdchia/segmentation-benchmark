// Store already-compressed PNGs in a ZIP, one file at a time.
// Blob parts retain compressed files without duplicating full-resolution masks.
const table=Uint32Array.from({length:256},(_,n)=>{
  let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;
});
async function crc32(blob) {
  let crc=0xffffffff;
  const reader=blob.stream().getReader();
  while(true) {const {done,value}=await reader.read();if(done)break;for(const b of value)crc=table[(crc^b)&255]^(crc>>>8);}
  return (crc^0xffffffff)>>>0;
}
function header(size) {const data=new Uint8Array(size);return {data,view:new DataView(data.buffer)};}

export async function storedZip(files) {
  const encoder=new TextEncoder(),parts=[],directory=[];
  let offset=0,count=0,directorySize=0;
  for await(const {name,blob} of files) {
    const filename=encoder.encode(name),size=blob.size;
    if(filename.length>65535||count>=65535||offset+size>0xffffffff)throw new Error('This export exceeds the supported ZIP size. Download masks individually.');
    const crc=await crc32(blob);
    const local=header(30);
    local.view.setUint32(0,0x04034b50,true);local.view.setUint16(4,20,true);local.view.setUint16(6,0x800,true);
    local.view.setUint16(12,33,true); // DOS date: 1980-01-01, for deterministic archives.
    local.view.setUint32(14,crc,true);local.view.setUint32(18,size,true);local.view.setUint32(22,size,true);local.view.setUint16(26,filename.length,true);
    parts.push(local.data,filename,blob);
    const central=header(46);
    central.view.setUint32(0,0x02014b50,true);central.view.setUint16(4,20,true);central.view.setUint16(6,20,true);central.view.setUint16(8,0x800,true);
    central.view.setUint16(14,33,true);central.view.setUint32(16,crc,true);central.view.setUint32(20,size,true);central.view.setUint32(24,size,true);
    central.view.setUint16(28,filename.length,true);central.view.setUint32(42,offset,true);
    directory.push(central.data,filename);directorySize+=46+filename.length;offset+=30+filename.length+size;count++;
  }
  if(offset+directorySize>0xffffffff)throw new Error('This export exceeds the supported ZIP size. Download masks individually.');
  const end=header(22);end.view.setUint32(0,0x06054b50,true);end.view.setUint16(8,count,true);end.view.setUint16(10,count,true);
  end.view.setUint32(12,directorySize,true);end.view.setUint32(16,offset,true);
  return new Blob([...parts,...directory,end.data],{type:'application/zip'});
}

export function uniqueMaskNames(names) {
  const used=new Set();
  return names.map(name=>{
    const stem=(name.replace(/\.[^.]+$/,'').replace(/[\\/\x00-\x1f]/g,'_')||'image');
    let candidate=`${stem}_mask.png`,suffix=2;
    while(used.has(candidate.toLowerCase()))candidate=`${stem}_mask_${suffix++}.png`;
    used.add(candidate.toLowerCase());return candidate;
  });
}
