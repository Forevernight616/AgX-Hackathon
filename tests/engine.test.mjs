import test from 'node:test';
import assert from 'node:assert/strict';
import {createState,tick,breakdown,runToEnd,compatible} from '../src/engine/core.js';
test('assignments satisfy implement and uniqueness constraints',()=>{const s=createState();for(const j of s.jobs.filter(j=>j.tractorId)){const t=s.tractors.find(t=>t.id===j.tractorId);assert.ok(compatible(t,j));assert.equal(t.jobId,j.id);}assert.equal(new Set(s.tractors.filter(t=>t.jobId).map(t=>t.jobId)).size,s.tractors.filter(t=>t.jobId).length);});
test('breakdown preserves completed progress and releases assignment',()=>{const s=createState();for(let i=0;i<14;i++)tick(s);const t=s.tractors.find(t=>t.jobId);assert.ok(t);const j=s.jobs.find(j=>j.id===t.jobId);const progress=j.progress;breakdown(s,t.id);assert.equal(t.status,'broken');assert.equal(j.progress,progress);assert.notEqual(j.tractorId,t.id);});
test('both dispatchers produce no constraint violations in demo',()=>{for(const mode of ['baseline','smart']){const s=runToEnd(undefined,mode);assert.equal(s.metrics.violations,0);assert.ok(s.metrics.completed>=0);assert.equal(s.jobs.filter(j=>j.status==='done'&&j.completedAt<=j.deadline).length,s.metrics.completed);}});

test('smart agents exchange proposals and preserve handoff memory',()=>{
 const s=createState(undefined,'smart');
 assert.ok(s.messages.some(m=>m.kind==='CALL_FOR_PROPOSALS'));
 assert.ok(s.messages.some(m=>m.kind==='PROPOSAL'));
 assert.ok(s.messages.some(m=>m.kind==='AWARD'));
 const t=s.tractors.find(t=>t.jobId);
 assert.ok(t);
 breakdown(s,t.id);
 assert.ok(s.messages.some(m=>m.kind==='HANDOFF'&&m.from===t.id));
 assert.ok(t.memory.some(m=>m.kind==='HANDOFF'));
});

test('orchestrator: Safety approves every committed plan, vetoes are logged, invariants hold',()=>{
 const s=runToEnd(undefined,'smart');
 assert.equal(s.metrics.violations,0);
 assert.equal(s.violationLog.length,0);
 assert.ok(s.plans.length>0);
 assert.equal(s.messages.filter(m=>m.kind==='APPROVE').length,s.plans.length);
 assert.ok(s.messages.some(m=>m.kind==='VETO'));
 assert.ok(s.explanations.length===s.plans.length);
});
test('breakdown handoff keeps partial progress and is explained as a move',()=>{
 // The default scenario has no scripted breakdowns (they are triggered manually in the UI), so inject one.
 const s=runToEnd(undefined,'smart',[{time:8,type:'breakdown',tractorId:'T1'}]);
 const moved=s.explanations.flatMap(e=>e.diff.moved);
 assert.ok(moved.length>=1);
 assert.match(moved[0].kept,/% kept/);
});
test('smart completes at least as many on-time jobs as FIFO baseline',()=>{
 const smart=runToEnd(undefined,'smart'),base=runToEnd(undefined,'baseline');
 assert.ok(smart.metrics.completed>=base.metrics.completed);
});
test('rescue: a field abandoned by a broken tractor is pledged, designated and finished by another tractor',()=>{
 for(const [id,at] of [['T1',6],['T3',40],['T1',24]]){
  const s=createState(undefined,'smart');while(s.time<at)tick(s);
  while(s.tractors.find(t=>t.id===id).status!=='working')tick(s);
  const jobId=s.tractors.find(t=>t.id===id).jobId;breakdown(s,id);
  assert.ok(s.messages.some(m=>m.kind==='HELP_REQUEST'&&m.jobId===jobId));
  assert.ok(s.messages.some(m=>m.kind==='DESIGNATE'&&m.jobId===jobId));
  while(s.time<s.horizon)tick(s);
  const j=s.jobs.find(j=>j.id===jobId);
  assert.equal(j.status,'done');assert.notEqual(j.tractorId,id);
  assert.ok(s.messages.some(m=>m.kind==='RESCUE_COMPLETE'&&m.jobId===jobId));
  assert.equal(s.metrics.violations,0);
 }
});
