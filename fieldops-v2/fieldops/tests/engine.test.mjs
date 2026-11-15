import test from 'node:test';
import assert from 'node:assert/strict';
import {createState,tick,breakdown,runToEnd,compatible} from '../src/engine/core.js';
test('assignments satisfy implement and uniqueness constraints',()=>{const s=createState();for(const j of s.jobs.filter(j=>j.tractorId)){const t=s.tractors.find(t=>t.id===j.tractorId);assert.ok(compatible(t,j));assert.equal(t.jobId,j.id);}assert.equal(new Set(s.tractors.filter(t=>t.jobId).map(t=>t.jobId)).size,s.tractors.filter(t=>t.jobId).length);});
test('breakdown preserves completed progress and releases assignment',()=>{const s=createState();for(let i=0;i<14;i++)tick(s);const t=s.tractors.find(t=>t.jobId);assert.ok(t);const j=s.jobs.find(j=>j.id===t.jobId);const progress=j.progress;breakdown(s,t.id);assert.equal(t.status,'broken');assert.equal(j.progress,progress);assert.notEqual(j.tractorId,t.id);});
test('both dispatchers produce no constraint violations in demo',()=>{for(const mode of ['baseline','smart']){const s=runToEnd(undefined,mode);assert.equal(s.metrics.violations,0);assert.ok(s.metrics.completed>=0);assert.equal(s.jobs.filter(j=>j.status==='done'&&j.completedAt<=j.deadline).length,s.metrics.completed);}});
