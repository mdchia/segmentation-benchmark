import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuThreadCount } from '../src/threads.js';

test('Auto uses half the reported logical cores, rounded up and capped at eight',()=>{
  assert.equal(cpuThreadCount('auto',1),1);
  assert.equal(cpuThreadCount('auto',3),2);
  assert.equal(cpuThreadCount('auto',7),4);
  assert.equal(cpuThreadCount('auto',8),4);
  assert.equal(cpuThreadCount('auto',12),6);
  assert.equal(cpuThreadCount('auto',16),8);
  assert.equal(cpuThreadCount('auto',32),8);
  assert.equal(cpuThreadCount('auto',undefined),1);
});

test('explicit choices are honored even on a machine with fewer reported cores',()=>{
  for(const count of [1,2,4,8])assert.equal(cpuThreadCount(String(count),2),count);
  for(const value of ['0','3','16','bad',null])assert.throws(()=>cpuThreadCount(value),/Invalid CPU thread setting/);
});
