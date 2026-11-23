import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { axisStarts, planTiles, packedLength, stitchTile, maskPixel, foregroundPixels, timingSummary } from '../src/core.js';
import { maskPng } from '../src/png.js';

test('full-resolution test photos have 48 edge-aligned tiles in reference order',()=>{
  const plan=planTiles(5464,8192);
  assert.equal(plan.coords.length,48);
  assert.deepEqual(plan.coords[0],{x:0,y:0});
  assert.deepEqual(plan.coords[1],{x:0,y:1024});
  assert.deepEqual(plan.coords.at(-1),{x:4440,y:7168});
  assert.deepEqual(axisStarts(1025),[0,1]);
  assert.deepEqual(axisStarts(1024),[0]);
});

test('every pixel is covered, with centered padding and reference overlap replacement',()=>{
  for(const [width,height] of [[1,1],[3,5],[9,4],[17,19],[19,1]]) {
    const tile=8, plan=planTiles(width,height,tile);
    const mask=new Uint8Array(packedLength(width,height));
    const reference=new Uint8Array(width*height);
    const visited=new Uint8Array(width*height);
    for(const [i,coord] of plan.coords.entries()) {
      const logits=Float32Array.from({length:tile*tile},(_,j)=>(j+i)%3===0?1:-1);
      stitchTile(mask,logits,plan,coord);
      for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
        const tx=x+plan.left-coord.x,ty=y+plan.top-coord.y;
        if(tx>=0&&tx<tile&&ty>=0&&ty<tile) {reference[y*width+x]=logits[ty*tile+tx]>=0;visited[y*width+x]++;}
      }
    }
    let fg=0;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
      assert.ok(visited[y*width+x]>0);
      assert.equal(maskPixel(mask,width,x,y),Boolean(reference[y*width+x]));fg+=reference[y*width+x];
    }
    assert.equal(foregroundPixels(mask),fg);
  }
});

test('zero logits identify roots; invalid logits fail explicitly',()=>{
  const plan=planTiles(1,1,1),mask=new Uint8Array(1);
  stitchTile(mask,new Float32Array([0]),plan,{x:0,y:0});assert.equal(mask[0],128);
  assert.throws(()=>stitchTile(mask,new Float32Array([NaN]),plan,{x:0,y:0}),/non-finite/);
});

test('PNG exports preserve original dimensions and white-root convention, including partial bytes',async()=>{
  const width=9,height=130;
  const mask=new Uint8Array(packedLength(width,height));
  mask[0]=0x80;mask[1]=0x80;mask[mask.length-1]=0x80;
  const bytes=Buffer.from(await (await maskPng(mask,width,height)).arrayBuffer());
  assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  const compressed=[];
  for(let offset=8;offset<bytes.length;) {
    const length=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,offset+8+length);
    if(type==='IHDR'){assert.equal(data.readUInt32BE(0),width);assert.equal(data.readUInt32BE(4),height);assert.equal(data[8],1);assert.equal(data[9],0);}
    if(type==='IDAT')compressed.push(data);
    offset+=length+12;
  }
  const raw=inflateSync(Buffer.concat(compressed)),stride=Math.ceil(width/8)+1;
  assert.equal(raw.length,stride*height);
  for(let y=0;y<height;y++) {
    assert.equal(raw[y*stride],0);
    for(let x=0;x<width;x++)assert.equal(Boolean(raw[y*stride+1+(x>>3)]&(0x80>>(x&7))),maskPixel(mask,width,x,y));
  }
});

test('timing includes first tile and reports a separate steady median',()=>{
  const summary=timingSummary([{totalMs:100,inferenceMs:90},{totalMs:10,inferenceMs:8},{totalMs:20,inferenceMs:18}]);
  assert.equal(summary.meanMs,130/3);assert.equal(summary.firstMs,100);assert.equal(summary.steadyMedianMs,15);
});
