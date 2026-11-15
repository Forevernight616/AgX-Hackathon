import source from '../data/scenario.json' with { type: 'json' };
const clone=x=>JSON.parse(JSON.stringify(x));
const key=(x,y)=>`${x},${y}`;
const center=f=>({x:Math.floor(f.x+(f.w-1)/2),y:Math.floor(f.y+(f.h-1)/2)});
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const compatibility={harvester:['harvest'],sprayer:['spray'],mower:['mow'],multi:['harvest','spray','mow']};
export const compatible=(t,j)=> (t.implements||[]).some(i=>(compatibility[i]||[]).includes(j.type)) || (t.capabilities||[]).includes(j.type);
export function route(start,end,s){
  const blocked=new Set((s.obstacles||[]).map(o=>key(o.x,o.y)));
  if(blocked.has(key(end.x,end.y)))return null;
  // Direct Euclidean route unless an obstacle lies on the segment; use grid detours when blocked.
  const touches=(a,b)=>{const n=Math.max(1,Math.ceil(distance(a,b)*8));for(let i=1;i<=n;i++){const x=Math.round(a.x+(b.x-a.x)*i/n),y=Math.round(a.y+(b.y-a.y)*i/n);if(blocked.has(key(x,y)))return true;}return false;};
  if(!touches(start,end))return [{x:end.x,y:end.y}];
  const q=[{x:Math.round(start.x),y:Math.round(start.y)}],prev=new Map([[key(q[0].x,q[0].y),null]]);
  for(let i=0;i<q.length;i++){
    const p=q[i],k=key(p.x,p.y);
    if(p.x===end.x&&p.y===end.y){const out=[];let v=k;while(v!==null){const [x,y]=v.split(',').map(Number);out.unshift({x,y});v=prev.get(v);}return out.slice(1);}
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const x=p.x+dx,y=p.y+dy,k2=key(x,y);if(x>=0&&y>=0&&x<s.width&&y<s.height&&!blocked.has(k2)&&!prev.has(k2)){prev.set(k2,k);q.push({x,y});}}
  }return null;
}
const pathLength=(start,path)=>path.reduce((acc,p,i)=>acc+distance(i?path[i-1]:start,p),0);
function log(s,type,message){s.logs.unshift({id:s.nextLog++,time:s.time,type,message});if(s.logs.length>1000)s.logs.pop();}
export function createState(config=source,mode='smart'){
 const s=clone(config);s.time=0;s.running=false;s.speed=1;s.mode=mode;s.nextLog=1;s.logs=[];s.metrics={travel:0,idle:0,completed:0,violations:0,missed:0};s.events=s.events||[];s.firedEvents=[];s.compatibility=compatibility;
 s.tractors=s.tractors.map(t=>({...t,implements:t.implements||((t.capabilities||[]).map(c=>({harvest:'harvester',spray:'sprayer',mow:'mower'}[c]))),capacity:t.capacity||100,speed:t.speed||1,travelBurn:t.travelBurn??0.75,workBurn:t.workBurn??0.85,status:'idle',jobId:null,path:[],travel:0,idle:0,work:0,reason:'Awaiting dispatch'}));
 s.jobs=s.jobs.map(j=>({...j,status:'pending',progress:0,tractorId:null,completedAt:null,reason:'Awaiting assignment',deadlineWarned:false}));
 log(s,'system',`Loaded ${s.name}: ${s.tractors.length} tractors, ${s.jobs.length} jobs.`);dispatch(s);return s;
}
function evaluate(s,t,j){
 if(t.status!=='idle'||!compatible(t,j))return null;
 const f=s.fields.find(f=>f.id===j.fieldId);if(!f)return null;
 const path=route(t,center(f),s);if(!path)return null;
 const dist=pathLength(t,path),duration=j.duration*(1-j.progress),travelTime=dist/t.speed,required=dist*t.travelBurn+duration*t.workBurn;
 const finish=s.time+travelTime+duration;
 if(required>t.fuel+1e-7)return null;
 return {path,dist,finish,required,travelTime,feasible:finish<=j.deadline+1e-7};
}
function assign(s,t,j,e){
 if(t.jobId||j.tractorId||j.status!=='pending'||!e.feasible){s.metrics.violations++;log(s,'critical',`Safety rejected duplicate or infeasible assignment of ${j.id}.`);return;}
 t.jobId=j.id;t.path=e.path;t.status=t.path.length?'traveling':'working';j.status='assigned';j.tractorId=t.id;
 t.reason=`Selected for ${j.id}: compatible ${t.implements.join('/')}, ${e.dist.toFixed(1)} distance units, ${e.required.toFixed(1)} fuel required, predicted finish t=${e.finish.toFixed(1)} before deadline t=${j.deadline}.`;
 j.reason=t.reason;log(s,'assignment',`${t.name} → ${j.id}. ${t.reason}`);
}
export function dispatch(s){
 const pending=s.jobs.filter(j=>j.status==='pending');
 if(s.mode==='baseline'){
  for(const j of pending){const option=s.tractors.map(t=>({t,e:evaluate(s,t,j)})).find(o=>o.e?.feasible);if(option)assign(s,option.t,j,option.e);}
 }else{
  while(true){let best=null;
   for(const j of s.jobs.filter(j=>j.status==='pending'))for(const t of s.tractors){const e=evaluate(s,t,j);if(!e?.feasible)continue;
    const score=j.priority*10000-e.dist*80-e.finish*4+(j.deadline-e.finish<10?250:0);
    if(!best||score>best.score)best={j,t,e,score};
   }if(!best)break;assign(s,best.t,best.j,best.e);
  }
 }
 for(const j of s.jobs.filter(j=>j.status==='pending')){
  if(j.deadline<s.time&&!j.deadlineWarned){j.deadlineWarned=true;s.metrics.missed++;j.reason='Deadline missed: no feasible assignment was completed in time.';log(s,'warning',`${j.id} missed deadline t=${j.deadline}; remains pending for operator review.`);}
  else if(!j.deadlineWarned){const feasible=s.tractors.some(t=>evaluate(s,t,j)?.feasible);if(!feasible)j.reason='Queued: no currently idle, compatible tractor can safely finish before the deadline with available fuel.';}
 }
}
function release(s,t,why){if(!t.jobId)return;const j=s.jobs.find(j=>j.id===t.jobId);if(j&&j.status!=='done'){j.status='pending';j.tractorId=null;j.reason=`${why}; ${(j.progress*100).toFixed(0)}% completed work retained.`;log(s,'decision',`${j.id} released: ${j.reason}`);}t.jobId=null;t.path=[];}
export function breakdown(s,id){const t=s.tractors.find(t=>t.id===id);if(!t||t.status==='broken')return;release(s,t,`${t.name} broke down`);t.status='broken';t.reason='Offline: breakdown';log(s,'critical',`${t.name} BROKEN DOWN. Safe replan started.`);dispatch(s);log(s,'decision',`Replan complete: ${s.jobs.filter(j=>j.status==='pending').length} jobs waiting, completed work preserved.`);}
export function repair(s,id){const t=s.tractors.find(t=>t.id===id);if(!t||t.status!=='broken')return;t.status='idle';t.reason='Repaired and available';log(s,'system',`${t.name} repaired.`);dispatch(s);}
export function refuel(s,id){const t=s.tractors.find(t=>t.id===id);if(!t||t.status!=='idle')return false;const d=distance(t,s.station);if(d*t.travelBurn>t.fuel)return false;t.fuel=t.capacity;log(s,'system',`${t.name} refueled at service station (operator-assisted).`);dispatch(s);return true;}
export function blockCell(s,x,y){if(x<0||y<0||x>=s.width||y>=s.height||s.tractors.some(t=>Math.round(t.x)===x&&Math.round(t.y)===y)||s.fields.some(f=>center(f).x===x&&center(f).y===y))return false;
 const k=key(x,y),i=s.obstacles.findIndex(o=>key(o.x,o.y)===k);if(i>=0){s.obstacles.splice(i,1);log(s,'system',`Route reopened at (${x},${y}).`);}else{s.obstacles.push({x,y});log(s,'warning',`Route blocked at (${x},${y}).`);}
 for(const t of s.tractors.filter(t=>t.status==='traveling')){const j=s.jobs.find(j=>j.id===t.jobId),f=s.fields.find(f=>f.id===j.fieldId),p=route(t,center(f),s);if(p){const required=pathLength(t,p)*t.travelBurn+j.duration*(1-j.progress)*t.workBurn;if(required<=t.fuel){t.path=p;log(s,'decision',`${t.name} rerouted safely.`);continue;}}release(s,t,'Route blocked or insufficient fuel for detour');t.status='idle';t.reason='Waiting for a feasible route';}dispatch(s);return true;
}
export function changePriority(s,id,priority){const j=s.jobs.find(j=>j.id===id);if(!j||j.status==='done')return;j.priority=priority;log(s,'decision',`${j.id} priority changed to ${priority}.`);dispatch(s);}
export function addJob(s,job){if(!s.fields.some(f=>f.id===job.fieldId)||!['spray','harvest','mow'].includes(job.type)||!Number.isFinite(job.duration)||job.duration<=0||!Number.isFinite(job.deadline)||job.deadline<=s.time)return false;
 const id=job.id||`J${Math.max(0,...s.jobs.map(j=>Number(j.id.slice(1))||0))+1}`;if(s.jobs.some(j=>j.id===id))return false;s.jobs.push({...job,id,status:'pending',progress:0,tractorId:null,completedAt:null,reason:'New operator job',deadlineWarned:false});log(s,'system',`Operator submitted ${id}.`);dispatch(s);return true;}
export function updateTractor(s,id,patch){const t=s.tractors.find(t=>t.id===id);if(!t||t.status!=='idle')return false;if(!Number.isFinite(patch.speed)||patch.speed<=0||!Number.isFinite(patch.fuel)||patch.fuel<0||patch.fuel>t.capacity||!Array.isArray(patch.implements)||!patch.implements.length)return false;Object.assign(t,{speed:patch.speed,fuel:patch.fuel,implements:patch.implements});log(s,'system',`${t.name} configuration updated.`);dispatch(s);return true;}
export function updateJob(s,id,patch){const j=s.jobs.find(j=>j.id===id);if(!j||j.status!=='pending'||!Number.isFinite(patch.deadline)||patch.deadline<=s.time||!Number.isFinite(patch.duration)||patch.duration<=0)return false;Object.assign(j,patch);log(s,'system',`${id} edited.`);dispatch(s);return true;}
function fireEvents(s){for(const [i,e] of s.events.entries()){if(e.time!==s.time||s.firedEvents.includes(i))continue;s.firedEvents.push(i);log(s,'system',`Scripted event #${i+1}: ${e.type}`);if(e.type==='breakdown')breakdown(s,e.tractorId);if(e.type==='block')blockCell(s,e.x,e.y);if(e.type==='priority')changePriority(s,e.jobId,e.priority);}}
export function tick(s){if(s.time>=s.horizon)return;fireEvents(s);s.time++;
 for(const t of s.tractors){if(t.status==='broken')continue;
  if(t.status==='idle'){t.idle++;s.metrics.idle++;continue;}
  const j=s.jobs.find(j=>j.id===t.jobId);if(!j){t.status='idle';continue;}
  if(t.status==='traveling'){
   let budget=t.speed,spent=0;
   while(budget>1e-8&&t.path.length){const target=t.path[0],d=distance(t,target);if(d<1e-8){t.path.shift();continue;}const move=Math.min(d,budget);t.x+=(target.x-t.x)*move/d;t.y+=(target.y-t.y)*move/d;budget-=move;spent+=move;if(move>=d-1e-8){t.x=target.x;t.y=target.y;t.path.shift();}}
   const elapsed=spent/t.speed;t.fuel=Math.max(0,t.fuel-spent*t.travelBurn);t.travel+=elapsed;s.metrics.travel+=elapsed;
   if(!t.path.length){t.status='working';j.status='in_progress';log(s,'movement',`${t.name} arrived at ${j.fieldId}.`);}
  }else if(t.status==='working'){
   const amount=Math.min(1-j.progress,1/j.duration);j.progress=Math.min(1,j.progress+amount);t.fuel=Math.max(0,t.fuel-amount*j.duration*t.workBurn);t.work+=amount*j.duration;
   if(j.progress>=1-1e-8){j.progress=1;j.status='done';j.completedAt=s.time;t.jobId=null;t.status='idle';t.reason='Available for next job';if(s.time<=j.deadline){s.metrics.completed++;log(s,'success',`${t.name} finished ${j.id} ON TIME at t=${s.time}.`);}else{if(!j.deadlineWarned){s.metrics.missed++;j.deadlineWarned=true;}log(s,'warning',`${j.id} finished late at t=${s.time}.`);}}
  }
  if(t.fuel<=1e-8&&t.jobId){release(s,t,'Fuel depleted');t.status='broken';s.metrics.violations++;log(s,'critical',`${t.name} ran out of fuel: safety violation.`);}
 }
 for(const j of s.jobs.filter(j=>j.status!=='done'&&!j.deadlineWarned&&s.time>j.deadline)){j.deadlineWarned=true;s.metrics.missed++;j.reason='Deadline missed; operator notified.';log(s,'warning',`${j.id} deadline missed at t=${s.time}.`);}
 dispatch(s);
}
export function runToEnd(config=source,mode='smart',events=null){const s=createState({...clone(config),events:events??config.events??[]},mode);while(s.time<s.horizon)tick(s);return s;}
export function exportLog(s){return JSON.stringify({scenario:s.name,mode:s.mode,metrics:s.metrics,events:[...s.logs].reverse()},null,2);}
export {source as defaultScenario};
