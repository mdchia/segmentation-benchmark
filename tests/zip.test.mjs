import test from 'node:test';
import assert from 'node:assert/strict';
import { storedZip, uniqueMaskNames } from '../src/zip.js';

test('ZIP entries preserve filenames, bytes, CRC32, offsets and directory',async()=>{
  const names=['roots.png','根.png'];
  const blobs=[new Blob(['123456789']),new Blob([new Uint8Array([0,128,255])])];
  const zip=Buffer.from(await(await storedZip(names.map((name,i)=>({name,blob:blobs[i]})))).arrayBuffer());
  const offsets=[];let offset=0;
  for(let i=0;i<2;i++) {
    offsets.push(offset);assert.equal(zip.readUInt32LE(offset),0x04034b50);
    assert.equal(zip.readUInt16LE(offset+6),0x800);assert.equal(zip.readUInt16LE(offset+8),0);
    const size=zip.readUInt32LE(offset+18),nameLength=zip.readUInt16LE(offset+26);
    assert.equal(zip.toString('utf8',offset+30,offset+30+nameLength),names[i]);
    assert.deepEqual(zip.subarray(offset+30+nameLength,offset+30+nameLength+size),Buffer.from(await blobs[i].arrayBuffer()));
    if(i===0)assert.equal(zip.readUInt32LE(offset+14),0xcbf43926);
    offset+=30+nameLength+size;
  }
  const directoryOffset=offset;
  for(let i=0;i<2;i++) {
    assert.equal(zip.readUInt32LE(offset),0x02014b50);assert.equal(zip.readUInt32LE(offset+42),offsets[i]);
    const length=zip.readUInt16LE(offset+28);
    assert.equal(zip.toString('utf8',offset+46,offset+46+length),names[i]);offset+=46+length;
  }
  assert.equal(zip.readUInt32LE(offset),0x06054b50);assert.equal(zip.readUInt16LE(offset+10),2);
  assert.equal(zip.readUInt32LE(offset+16),directoryOffset);assert.equal(offset+22,zip.length);
});

test('mask filenames are unique and cannot create paths inside a ZIP',()=>{
  assert.deepEqual(uniqueMaskNames(['root.jpg','root.png','ROOT.JPG','../other.jpg','根.png']),
    ['root_mask.png','root_mask_2.png','ROOT_mask_3.png','.._other_mask.png','根_mask.png']);
});
