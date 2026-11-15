// Simulator core: state, tick loop, events, FIFO baseline. Smart mode delegates every
// decision to the agent layer in ./agents.js (Orchestrator → Fleet/Navigation/Safety/Agronomy).
import source from '../data/scenario.json' with { type: 'json' };
import {key, center, distance, compatibility, compatible, route, pathLength} from './nav.js';
import {orchestrate, Safety, Agronomy, REFUEL_MINUTES} from './agents.js';
export {compatible, route};

const clone = x => JSON.parse(JSON.stringify(x));

function log(s, type, message) {
  s.logs.unshift({id: s.nextLog++, time: s.time, type, message});
  if (s.logs.length > 1500) s.logs.pop();
}
function message(s, from, to, kind, jobId, detail, plan = null) {
  const entry = {id: s.nextMessage++, time: s.time, from, to, kind, jobId, detail, plan};
  s.messages.push(entry);
  if (s.messages.length > 3000) s.messages.shift();
  log(s, 'message', `${from} → ${to} [${kind}]${jobId ? ' ' + jobId : ''}: ${detail}`);
  const sender = s.tractors.find(t => t.id === from);
  if (sender) sender.memory.push({time: s.time, kind, jobId, detail});
  const receiver = s.tractors.find(t => t.id === to);
  if (receiver) receiver.memory.push({time: s.time, kind: `received:${kind}`, jobId, detail});
}
const trigger = (s, type, data = {}) => { if (s.mode === 'smart') s.triggers.push({type, time: s.time, ...data}); };

export function createState(config = source, mode = 'smart') {
  const s = clone(config);
  Object.assign(s, {
    time: 0, running: false, speed: 1, mode, nextLog: 1, logs: [], nextMessage: 1, messages: [], orchestratorMemory: [],
    agentStats: {proposals: 0, awards: 0, handovers: 0, replans: 0, vetoes: 0, refuels: 0, latencyMs: 0},
    metrics: {travel: 0, idle: 0, completed: 0, violations: 0, missed: 0, late: 0, agronomyBreaches: 0},
    events: s.events || [], firedEvents: [], compatibility, obstacles: s.obstacles || [],
    triggers: [], released: {}, planVersion: 0, plans: [], explanations: [], bids: {}, violationLog: [],
  });
  s.tractors = s.tractors.map(t => ({
    ...t, implements: t.implements || (t.capabilities || []).map(c => ({harvest: 'harvester', spray: 'sprayer', mow: 'mower'}[c])),
    capacity: t.capacity || 100, speed: t.speed || 1, travelBurn: t.travelBurn ?? 0.75, workBurn: t.workBurn ?? 0.85,
    status: 'idle', jobId: null, task: null, path: [], travel: 0, idle: 0, work: 0, refuelLeft: 0, reason: 'Awaiting dispatch', memory: [], agentId: t.id,
  }));
  s.jobs = s.jobs.map(j => ({...j, status: 'pending', progress: 0, tractorId: null, completedAt: null, reason: 'Awaiting assignment', deadlineWarned: false}));
  s.agronomyTimes = [...Agronomy.boundaries(s)];
  log(s, 'system', `Loaded ${s.name}: ${s.tractors.length} tractors, ${s.jobs.length} jobs (${mode === 'smart' ? 'AI Farm Orchestrator' : 'FIFO baseline'}).`);
  trigger(s, 'SUBMITTED');
  dispatch(s);
  return s;
}

// Baseline feasibility check (also used for the operator-facing "queued" reasons).
function evaluate(s, t, j) {
  if (t.status !== 'idle' || t.task || !compatible(t, j)) return null;
  const f = s.fields.find(f => f.id === j.fieldId); if (!f) return null;
  const path = route(t, center(f), s); if (!path) return null;
  const dist = pathLength(t, path), duration = j.duration * (1 - j.progress), travelTime = dist / t.speed;
  const required = dist * t.travelBurn + duration * t.workBurn, finish = s.time + travelTime + duration;
  if (required > t.fuel + 1e-7) return null;
  return {path, dist, finish, required, travelTime, feasible: finish <= j.deadline + 1e-7};
}

function assign(s, t, j, e) {
  if (t.jobId || t.task || t.status === 'broken' || j.tractorId || j.status !== 'pending' || !e.feasible || !compatible(t, j)) {
    s.metrics.violations++; log(s, 'critical', `Safety rejected duplicate or infeasible assignment of ${j.id}.`); return;
  }
  // The baseline doesn't consult Agronomy; count when it works against a field/crop rule (for a fair comparison).
  const breach = Agronomy.review(s, j, s.time + e.travelTime, e.finish);
  if (breach) { s.metrics.agronomyBreaches++; log(s, 'warning', `Agronomy breach: ${j.id} ${breach}.`); }
  t.jobId = j.id; t.path = e.path; t.status = t.path.length ? 'traveling' : 'working';
  j.status = t.status === 'working' ? 'in_progress' : 'assigned'; j.tractorId = t.id;
  t.reason = `Selected for ${j.id}: compatible ${t.implements.join('/')}, ${e.dist.toFixed(1)} distance units, ${e.required.toFixed(1)} fuel required, predicted finish t=${e.finish.toFixed(1)} before deadline t=${j.deadline}.`;
  j.reason = t.reason;
  log(s, 'assignment', `${t.name} → ${j.id}. ${t.reason}`);
  if (s.mode === 'smart') {
    message(s, 'Orchestrator', t.id, 'AWARD', j.id, `plan v${s.planVersion}: ${t.id} does ${j.id}, ETA t=${e.finish.toFixed(1)}`, s.planVersion);
    s.agentStats.awards++; s.agentStats.proposals++;
    s.orchestratorMemory.push({time: s.time, kind: 'assignment', jobId: j.id, tractorId: t.id, plan: s.planVersion});
  }
}

function startRefuel(s, t, why) {
  const path = route(t, s.station, s);
  if (!path) return;
  t.task = 'refuel'; t.path = path; t.status = path.length && distance(t, s.station) > 1e-8 ? 'traveling' : 'refueling';
  if (t.status === 'refueling') t.refuelLeft = REFUEL_MINUTES;
  t.reason = `Refuel trip: ${why}`;
  log(s, 'decision', `${t.name} heads to the depot to refuel (${why}).`);
  message(s, 'Orchestrator', t.id, 'REFUEL', null, `go to depot (${s.station.x},${s.station.y}): ${why}`, s.planVersion);
}

const ctx = {message, assign, startRefuel, log};

export function dispatch(s) {
  if (s.mode === 'baseline') {
    // FIFO: jobs in submission order; first compatible idle tractor that can start it. No lookahead.
    for (const j of s.jobs.filter(j => j.status === 'pending')) {
      const option = s.tractors.map(t => ({t, e: evaluate(s, t, j)})).find(o => o.e?.feasible);
      if (option) assign(s, option.t, j, option.e);
    }
  } else if (s.triggers.length) {
    // Event-driven: the Orchestrator only replans when something happened.
    orchestrate(s, s.triggers.splice(0), ctx);
  }
  for (const j of s.jobs.filter(j => j.status === 'pending')) {
    if (j.deadline < s.time && !j.deadlineWarned) {
      j.deadlineWarned = true; s.metrics.missed++; j.reason = 'Deadline missed: no feasible assignment was completed in time.';
      log(s, 'warning', `${j.id} missed deadline t=${j.deadline}; remains pending for operator review.`);
    } else if (!j.deadlineWarned && !s.tractors.some(t => evaluate(s, t, j)?.feasible)) {
      j.reason = 'Queued: no currently idle, compatible tractor can safely finish before the deadline with available fuel.';
    }
  }
}

function release(s, t, why) {
  if (!t.jobId) return null;
  const j = s.jobs.find(j => j.id === t.jobId);
  let released = null;
  if (j && j.status !== 'done') {
    j.status = 'pending'; j.tractorId = null;
    j.reason = `${why}; ${(j.progress * 100).toFixed(0)}% completed work retained.`;
    log(s, 'decision', `${j.id} released: ${j.reason}`);
    released = {jobId: j.id, progress: j.progress};
    if (s.mode === 'smart') {
      message(s, t.id, 'Orchestrator', 'HANDOFF', j.id, `${j.reason} Remaining ${(j.duration * (1 - j.progress)).toFixed(1)} of ${j.duration} min.`);
      s.agentStats.handovers++;
      s.orchestratorMemory.push({time: s.time, kind: 'handoff', jobId: j.id, tractorId: t.id, progress: j.progress});
    }
  }
  t.jobId = null; t.path = [];
  return released;
}

export function breakdown(s, id) {
  const t = s.tractors.find(t => t.id === id);
  if (!t || t.status === 'broken') return;
  const r = release(s, t, `${t.name} broke down`);
  t.status = 'broken'; t.task = null; t.path = []; t.reason = 'Offline: breakdown';
  log(s, 'critical', `${t.name} BROKEN DOWN. Safe replan started.`);
  trigger(s, 'BREAKDOWN', {tractorId: id, jobId: r?.jobId || null, progress: r?.progress || 0});
  dispatch(s);
  log(s, 'decision', `Replan complete: ${s.jobs.filter(j => j.status === 'pending').length} jobs waiting, completed work preserved.`);
}
export function repair(s, id) {
  const t = s.tractors.find(t => t.id === id);
  if (!t || t.status !== 'broken') return;
  t.status = 'idle'; t.reason = 'Repaired and available';
  log(s, 'system', `${t.name} repaired.`);
  trigger(s, 'REPAIRED', {tractorId: id});
  dispatch(s);
}
// Operator-assisted instant refuel for an idle tractor (manual override).
export function refuel(s, id) {
  const t = s.tractors.find(t => t.id === id);
  if (!t || t.status !== 'idle' || t.task) return false;
  if (distance(t, s.station) * t.travelBurn > t.fuel) return false;
  t.fuel = t.capacity;
  log(s, 'system', `${t.name} refueled at service station (operator-assisted).`);
  trigger(s, 'REFUELED', {tractorId: id});
  dispatch(s);
  return true;
}
export function blockCell(s, x, y) {
  if (x < 0 || y < 0 || x >= s.width || y >= s.height || s.tractors.some(t => Math.round(t.x) === x && Math.round(t.y) === y) ||
      s.fields.some(f => center(f).x === x && center(f).y === y) || (s.station.x === x && s.station.y === y)) return false;
  const k = key(x, y), i = s.obstacles.findIndex(o => key(o.x, o.y) === k);
  if (i >= 0) { s.obstacles.splice(i, 1); log(s, 'system', `Route reopened at (${x},${y}).`); trigger(s, 'ROUTE_REOPENED', {x, y}); }
  else { s.obstacles.push({x, y}); log(s, 'warning', `Route blocked at (${x},${y}).`); trigger(s, 'ROUTE_BLOCKED', {x, y}); }
  for (const t of s.tractors.filter(t => t.status === 'traveling')) {
    const j = t.jobId && s.jobs.find(j => j.id === t.jobId);
    const dest = j ? center(s.fields.find(f => f.id === j.fieldId)) : s.station;
    const p = route(t, dest, s);
    const required = p ? pathLength(t, p) * t.travelBurn + (j ? j.duration * (1 - j.progress) * t.workBurn : 0) : Infinity;
    if (p && required <= t.fuel) {
      t.path = p; log(s, 'decision', `${t.name} rerouted safely.`);
      if (s.mode === 'smart') message(s, 'Navigation', t.id, 'REROUTE', t.jobId, `new path ${pathLength(t, p).toFixed(1)} cells to ${j ? j.fieldId : 'depot'}`);
      continue;
    }
    if (j) { const r = release(s, t, 'Route blocked or insufficient fuel for detour'); trigger(s, 'RELEASED', {tractorId: t.id, jobId: r?.jobId, progress: r?.progress || 0, why: 'route blocked'}); }
    t.status = 'idle'; t.task = null; t.path = []; t.reason = 'Waiting for a feasible route';
  }
  dispatch(s);
  return true;
}
export function changePriority(s, id, priority) {
  const j = s.jobs.find(j => j.id === id);
  if (!j || j.status === 'done') return;
  j.priority = priority;
  log(s, 'decision', `${j.id} priority changed to ${priority}.`);
  trigger(s, 'PRIORITY', {jobId: id, priority});
  dispatch(s);
}
export function addJob(s, job) {
  if (!s.fields.some(f => f.id === job.fieldId) || !['spray', 'harvest', 'mow'].includes(job.type) || !Number.isFinite(job.duration) ||
      job.duration <= 0 || !Number.isFinite(job.deadline) || job.deadline <= s.time) return false;
  const id = job.id || `J${Math.max(0, ...s.jobs.map(j => Number(j.id.slice(1)) || 0)) + 1}`;
  if (s.jobs.some(j => j.id === id)) return false;
  s.jobs.push({...job, id, status: 'pending', progress: 0, tractorId: null, completedAt: null, reason: 'New operator job', deadlineWarned: false});
  log(s, 'system', `Operator submitted ${id}.`);
  trigger(s, 'JOB_ADDED', {jobId: id});
  dispatch(s);
  return true;
}
export function updateTractor(s, id, patch) {
  const t = s.tractors.find(t => t.id === id);
  if (!t || t.status !== 'idle' || t.task) return false;
  if (!Number.isFinite(patch.speed) || patch.speed <= 0 || !Number.isFinite(patch.fuel) || patch.fuel < 0 || patch.fuel > t.capacity ||
      !Array.isArray(patch.implements) || !patch.implements.length) return false;
  Object.assign(t, {speed: patch.speed, fuel: patch.fuel, implements: patch.implements});
  log(s, 'system', `${t.name} configuration updated.`);
  trigger(s, 'OPERATOR_EDIT', {id});
  dispatch(s);
  return true;
}
export function updateJob(s, id, patch) {
  const j = s.jobs.find(j => j.id === id);
  if (!j || j.status !== 'pending' || !Number.isFinite(patch.deadline) || patch.deadline <= s.time || !Number.isFinite(patch.duration) || patch.duration <= 0) return false;
  Object.assign(j, patch);
  log(s, 'system', `${id} edited.`);
  trigger(s, 'OPERATOR_EDIT', {id});
  dispatch(s);
  return true;
}

function fireEvents(s) {
  for (const [i, e] of s.events.entries()) {
    if (e.time !== s.time || s.firedEvents.includes(i)) continue;
    s.firedEvents.push(i);
    log(s, 'system', `Scripted event #${i + 1}: ${e.type}`);
    if (e.type === 'breakdown') breakdown(s, e.tractorId);
    if (e.type === 'repair') repair(s, e.tractorId);
    if (e.type === 'block') blockCell(s, e.x, e.y);
    if (e.type === 'priority') changePriority(s, e.jobId, e.priority);
  }
}

// Move a tractor along its path for one minute. Returns cells travelled.
function move(s, t) {
  let budget = t.speed, spent = 0;
  while (budget > 1e-8 && t.path.length) {
    const target = t.path[0], d = distance(t, target);
    if (d < 1e-8) { t.path.shift(); continue; }
    const m = Math.min(d, budget);
    t.x += (target.x - t.x) * m / d; t.y += (target.y - t.y) * m / d; budget -= m; spent += m;
    if (m >= d - 1e-8) { t.x = target.x; t.y = target.y; t.path.shift(); }
  }
  const elapsed = spent / t.speed;
  t.fuel = Math.max(0, t.fuel - spent * t.travelBurn); t.travel += elapsed; s.metrics.travel += elapsed;
  return spent;
}

export function tick(s) {
  if (s.time >= s.horizon) return;
  fireEvents(s);
  s.time++;
  if (s.agronomyTimes?.includes(s.time)) trigger(s, 'AGRONOMY_WINDOW');
  for (const t of s.tractors) {
    if (t.status === 'broken') continue;
    if (t.task === 'refuel') {
      if (t.status === 'traveling') { move(s, t); if (!t.path.length) { t.status = 'refueling'; t.refuelLeft = REFUEL_MINUTES; log(s, 'movement', `${t.name} arrived at depot.`); } }
      else if (t.status === 'refueling' && --t.refuelLeft <= 0) {
        t.fuel = t.capacity; t.task = null; t.status = 'idle'; t.reason = 'Refueled; available';
        log(s, 'success', `${t.name} refueled to ${t.capacity}%.`);
        message(s, t.id, 'Orchestrator', 'REFUELED', null, `fuel ${t.capacity}%, ready for work`);
        trigger(s, 'REFUELED', {tractorId: t.id});
      }
      continue;
    }
    // Idle = an available tractor doing nothing while work is still open.
    if (t.status === 'idle') { if (s.jobs.some(j => j.status !== 'done')) { t.idle++; s.metrics.idle++; } continue; }
    const j = s.jobs.find(j => j.id === t.jobId);
    if (!j) { t.status = 'idle'; continue; }
    if (t.status === 'traveling') {
      move(s, t);
      if (!t.path.length) { t.status = 'working'; j.status = 'in_progress'; log(s, 'movement', `${t.name} arrived at ${j.fieldId}.`); }
    } else if (t.status === 'working') {
      const amount = Math.min(1 - j.progress, 1 / j.duration);
      j.progress = Math.min(1, j.progress + amount); t.fuel = Math.max(0, t.fuel - amount * j.duration * t.workBurn); t.work += amount * j.duration;
      if (j.progress >= 1 - 1e-8) {
        j.progress = 1; j.status = 'done'; j.completedAt = s.time; t.jobId = null; t.status = 'idle'; t.reason = 'Available for next job';
        if (s.time <= j.deadline) {
          s.metrics.completed++; log(s, 'success', `${t.name} finished ${j.id} ON TIME at t=${s.time}.`);
          if (s.mode === 'smart') message(s, t.id, 'Orchestrator', 'COMPLETED', j.id, `Finished at t=${s.time}; progress retained in job record.`);
        } else {
          s.metrics.late++; if (!j.deadlineWarned) { s.metrics.missed++; j.deadlineWarned = true; }
          log(s, 'warning', `${j.id} finished late at t=${s.time}.`);
        }
        trigger(s, 'JOB_DONE', {tractorId: t.id, jobId: j.id});
      }
    }
    if (t.fuel <= 1e-8 && t.jobId) {
      release(s, t, 'Fuel depleted'); t.status = 'broken'; s.metrics.violations++;
      log(s, 'critical', `${t.name} ran out of fuel: safety violation.`);
    }
  }
  for (const j of s.jobs.filter(j => j.status !== 'done' && !j.deadlineWarned && s.time > j.deadline)) {
    j.deadlineWarned = true; s.metrics.missed++; j.reason = 'Deadline missed; operator notified.';
    log(s, 'warning', `${j.id} deadline missed at t=${s.time}.`);
  }
  dispatch(s);
  // Safety Agent invariant sweep after every tick (both dispatchers).
  for (const v of Safety.invariants(s)) {
    s.metrics.violations++; s.violationLog.push({time: s.time, violation: v});
    log(s, 'critical', `INVARIANT VIOLATED: ${v}`);
  }
}

export function runToEnd(config = source, mode = 'smart', events = null) {
  const s = createState({...clone(config), events: events ?? config.events ?? []}, mode);
  while (s.time < s.horizon) tick(s);
  return s;
}
export function exportLog(s) {
  return JSON.stringify({
    scenario: s.name, mode: s.mode, metrics: s.metrics, agentStats: s.agentStats,
    plans: s.plans, explanations: s.explanations.map(e => ({version: e.version, time: e.time, source: e.source, text: e.text, diff: e.diff})),
    messages: s.messages, violations: s.violationLog,
    agentMemory: Object.fromEntries(s.tractors.map(t => [t.id, t.memory])), events: [...s.logs].reverse(),
  }, null, 2);
}
export {source as defaultScenario};
