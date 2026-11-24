import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuThreadCount, cpuSessionPlan } from '../src/threads.js';

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

test('Auto splits budgets of six or more threads into 2-thread sessions',()=>{
  assert.deepEqual(cpuSessionPlan('auto',16,8),{sessions:4,threadsPerSession:2,threads:8});
  assert.deepEqual(cpuSessionPlan('auto',12,undefined),{sessions:3,threadsPerSession:2,threads:6});
  assert.deepEqual(cpuSessionPlan('auto',8,8),{sessions:1,threadsPerSession:4,threads:4});
  assert.deepEqual(cpuSessionPlan('auto',7,8),{sessions:1,threadsPerSession:4,threads:4});
});

test('explicit settings, low reported memory and missing threading keep one session',()=>{
  for(const count of [1,2,4,8])assert.deepEqual(cpuSessionPlan(String(count),16,8),{sessions:1,threadsPerSession:count,threads:count});
  assert.deepEqual(cpuSessionPlan('auto',16,4),{sessions:1,threadsPerSession:8,threads:8});
  assert.deepEqual(cpuSessionPlan('auto',16,8,false),{sessions:1,threadsPerSession:1,threads:1});
});

test('small Auto batches keep one session with every thread',()=>{
  assert.deepEqual(cpuSessionPlan('auto',16,8,true,23),{sessions:1,threadsPerSession:8,threads:8});
  assert.deepEqual(cpuSessionPlan('auto',16,8,true,24),{sessions:4,threadsPerSession:2,threads:8});
  assert.deepEqual(cpuSessionPlan('auto',12,8,true,18),{sessions:3,threadsPerSession:2,threads:6});
  assert.equal(cpuSessionPlan('auto',12,8,true,17).sessions,1);
});
