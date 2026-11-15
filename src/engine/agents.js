// AI Farm Orchestrator — the agentic layer.
//
// Every agent is a code component with ONE job. Decisions are deterministic and provable;
// the LLM (Explainer Agent, backend/llm_agent.py) only turns the facts produced here into words.
//
//   Orchestrator  event-driven loop: trigger -> Fleet proposes -> Safety approves/vetoes -> commit -> diff -> explain
//   Fleet         tracks tractor status, runs a contract-net auction with regret ordering, proposes plan vN+1
//   Navigation    routes / travel time / fuel to the depot, avoids blocked cells
//   Safety        validates every plan (APPROVE | VETO(reason)) and checks invariants after every tick
//   Agronomy      field & crop rules (wind limit for spraying, wet fields) that Safety enforces
import {center, compatible, route, pathLength} from './nav.js';

export const FUEL_MARGIN = 2;     // % fuel kept on top of the trip back to the depot
export const REFUEL_MINUTES = 3;
const MAX_ROUNDS = 6;             // propose/veto rounds before escalating to the operator
const W_PRIORITY = 10, SOLE_BIDDER_REGRET = 30;
// Rescue coordination: a job abandoned mid-field by a broken tractor is a *rescue job*. Its deadline becomes
// soft (finishing late beats leaving a half-worked field), lateness is penalised in the bid cost, and rescue
// jobs are auctioned before ordinary work so the designated helper goes there as soon as it is free.
const RESCUE_BOOST = 60, LATE_WEIGHT = 1;
export const isRescue = (s, j) => !!s.released?.[j.id];

const r1 = x => Math.round(x * 10) / 10;
const now = () => (globalThis.performance?.now?.() ?? Date.now());
const fieldOf = (s, j) => s.fields.find(f => f.id === j.fieldId);
const remaining = j => j.duration * (1 - j.progress);
const pairKey = (tractorId, jobId) => `${tractorId}|${jobId}`;
const isFree = t => t.status === 'idle' && !t.jobId && !t.task;

// ───────────────────────────── Navigation Agent ─────────────────────────────
export const Navigation = {
  leg(s, from, to) {
    const path = route(from, to, s);
    return path ? {path, dist: pathLength(from, path)} : null;
  },
  toJob(s, t, j) {
    const f = fieldOf(s, j);
    if (!f) return null;
    const dest = center(f), leg = this.leg(s, t, dest);
    return leg ? {...leg, dest, travelTime: leg.dist / t.speed, detour: leg.path.length > 1} : null;
  },
  // Fuel needed to get from `point` back to the depot, plus a safety margin.
  depotReserve(s, t, point) {
    const leg = this.leg(s, point, s.station);
    return leg ? leg.dist * t.travelBurn + FUEL_MARGIN : Infinity;
  },
  toDepot(s, t) {
    const leg = this.leg(s, t, s.station);
    return leg ? {...leg, fuel: leg.dist * t.travelBurn, travelTime: leg.dist / t.speed} : null;
  },
};

// ───────────────────────────── Agronomy Agent ───────────────────────────────
export const Agronomy = {
  rules: s => s.agronomy || {},
  // Returns null if the work window [start, end] is agronomically fine, else a reason.
  review(s, j, start, end) {
    const a = this.rules(s), limit = a.maxSprayWind ?? 25;
    if (j.type === 'spray') {
      for (const w of a.wind || []) {
        if (w.kmh > limit && start < w.to && end > w.from)
          return `wind ${w.kmh} km/h forecast t=${w.from}–${w.to} exceeds the ${limit} km/h spray limit (drift risk)`;
      }
    }
    for (const w of a.wetFields || []) {
      if (w.fieldId === j.fieldId && (!w.types || w.types.includes(j.type)) && start < w.until)
        return `${fieldOf(s, j)?.name || j.fieldId} is too wet for ${j.type} until t=${w.until} (${w.note || 'soil compaction risk'})`;
    }
    return null;
  },
  // Times at which a rule switches on/off — the Orchestrator replans at these moments.
  boundaries(s) {
    const a = this.rules(s), out = new Set();
    for (const w of a.wind || []) { out.add(w.from); out.add(w.to); }
    for (const w of a.wetFields || []) out.add(w.until);
    return out;
  },
};

// ───────────────────────────── Fleet Agent ──────────────────────────────────
export const Fleet = {
  // A tractor's bid for a job. {ok:true, cost, ...} or {ok:false, reason, category}.
  bid(s, t, j, {ignoreBusy = false, allowLate = isRescue(s, j)} = {}) {
    const no = (reason, category = 'other') => ({ok: false, reason, category});
    if (t.status === 'broken') return no('broken down', 'broken');
    if (!ignoreBusy && !isFree(t)) return no(t.jobId ? `busy with ${t.jobId}` : t.task ? `on ${t.task} trip` : `status ${t.status}`, 'busy');
    if (!compatible(t, j)) return no(`no ${j.type} implement (has ${t.implements.join('/')})`, 'implement');
    const leg = Navigation.toJob(s, t, j);
    if (!leg) return no('no route to field (blocked)', 'route');
    const work = remaining(j), required = leg.dist * t.travelBurn + work * t.workBurn;
    if (required > t.fuel + 1e-7) return no(`fuel ${r1(t.fuel)}% < ${r1(required)}% needed`, 'fuel');
    const finish = s.time + leg.travelTime + work;
    const late = Math.max(0, finish - j.deadline);
    if (late > 1e-7 && !allowLate) return no(`would finish t=${r1(finish)}, after deadline t=${j.deadline}`, 'deadline');
    // Cost = minutes of travel (wasted time) + small weight on how long the job takes to complete (+ lateness for rescues).
    const cost = leg.travelTime + 0.15 * (finish - s.time) + LATE_WEIGHT * late;
    return {ok: true, tractorId: t.id, jobId: j.id, path: leg.path, dist: leg.dist, travelTime: leg.travelTime, finish, required, cost, detour: leg.detour, late};
  },

  // When could a (possibly busy) tractor be free, where, and with how much fuel?
  availability(s, t) {
    if (t.status === 'broken') return null;
    if (t.task === 'refuel') {
      const travel = pathLength(t, t.path || []) / t.speed;
      return {at: s.time + travel + (t.status === 'refueling' ? t.refuelLeft : REFUEL_MINUTES), pos: {...s.station}, fuel: t.capacity, after: 'refuelling'};
    }
    if (!t.jobId) return {at: s.time, pos: {x: t.x, y: t.y}, fuel: t.fuel, after: null};
    const j = s.jobs.find(j => j.id === t.jobId), f = j && fieldOf(s, j);
    const dist = pathLength(t, t.path || []), work = j ? remaining(j) : 0;
    return {at: s.time + dist / t.speed + work, pos: f ? center(f) : {x: t.x, y: t.y}, fuel: t.fuel - dist * t.travelBurn - work * t.workBurn, after: t.jobId};
  },

  // A tractor's answer to a HELP_REQUEST: commit to finishing a rescue job once it is free.
  pledge(s, t, j) {
    const no = reason => ({ok: false, tractorId: t.id, reason});
    if (t.status === 'broken') return no('broken down');
    if (!compatible(t, j)) return no(`no ${j.type} implement`);
    const av = this.availability(s, t);
    if (!av) return no('unavailable');
    const ghost = {...t, x: av.pos.x, y: av.pos.y, fuel: av.fuel, status: 'idle', jobId: null, task: null, path: []};
    const leg = Navigation.toJob(s, ghost, j);
    if (!leg) return no('no open route to the field');
    const need = leg.dist * t.travelBurn + remaining(j) * t.workBurn, reserve = Navigation.depotReserve(s, t, leg.dest);
    // Not enough fuel: it would refuel first (depot round trip) — still a valid, slower pledge.
    let start = av.at, viaDepot = false;
    if (av.fuel < need + reserve) {
      const toDepot = Navigation.leg(s, av.pos, s.station);
      if (!toDepot) return no('cannot reach the depot to refuel');
      const fromDepot = Navigation.toJob(s, {...ghost, x: s.station.x, y: s.station.y, fuel: t.capacity}, j);
      if (!fromDepot) return no('no open route from the depot');
      start += toDepot.dist / t.speed + REFUEL_MINUTES; viaDepot = true;
      const finish = start + fromDepot.travelTime + remaining(j);
      return {ok: true, tractorId: t.id, after: av.after, freeAt: av.at, arrive: start + fromDepot.travelTime, finish, viaDepot};
    }
    return {ok: true, tractorId: t.id, after: av.after, freeAt: av.at, arrive: start + leg.travelTime, finish: start + leg.travelTime + remaining(j), viaDepot};
  },

  // Propose a plan for all pending jobs using the currently free tractors.
  // excluded: Map<pairKey, vetoReason> learned from Safety this round. refuelWanted: tractors Safety says must refuel.
  propose(s, excluded = new Map(), refuelWanted = new Set()) {
    const pending = s.jobs.filter(j => j.status === 'pending');
    const refuels = [];
    for (const id of refuelWanted) {
      const t = s.tractors.find(t => t.id === id);
      if (t && isFree(t) && t.fuel < t.capacity - 1) refuels.push({tractorId: id, reason: [...excluded.entries()].find(([k]) => k.startsWith(id + '|'))?.[1] || 'low fuel'});
    }
    const refuelIds = new Set(refuels.map(r => r.tractorId));
    const free = s.tractors.filter(t => isFree(t) && !refuelIds.has(t.id));

    // Full bid book: every tractor's answer for every pending job (these become the "why?" facts).
    const book = {}, valid = {}, fuelBlocked = new Set();
    for (const j of pending) {
      book[j.id] = {}; valid[j.id] = [];
      for (const t of s.tractors) {
        const k = pairKey(t.id, j.id);
        if (refuelIds.has(t.id)) { book[j.id][t.id] = 'no bid: heading to depot to refuel'; continue; }
        if (excluded.has(k)) { book[j.id][t.id] = `vetoed by Safety: ${excluded.get(k)}`; continue; }
        const b = this.bid(s, t, j);
        if (b.ok) { book[j.id][t.id] = `cost ${r1(b.cost)} (travel ${r1(b.travelTime)} min, fuel ${r1(b.required)}%, ETA t=${r1(b.finish)})`; valid[j.id].push(b); }
        else { book[j.id][t.id] = `no bid: ${b.reason}`; if (b.category === 'fuel' && isFree(t)) fuelBlocked.add(t.id); }
      }
      valid[j.id].sort((a, b) => a.cost - b.cost || a.tractorId.localeCompare(b.tractorId));
    }

    // Regret auction: repeatedly award the job whose best-vs-second-best gap (plus priority, urgency) is largest.
    const assignments = [], taken = new Set(), awarded = new Set();
    while (true) {
      let pick = null;
      for (const j of pending) {
        if (awarded.has(j.id)) continue;
        const bids = valid[j.id].filter(b => !taken.has(b.tractorId));
        if (!bids.length) continue;
        const regret = bids[1] ? bids[1].cost - bids[0].cost : SOLE_BIDDER_REGRET;
        const slack = j.deadline - bids[0].finish, urgency = Math.max(0, 20 - slack) * 0.5;
        const score = W_PRIORITY * j.priority + regret + urgency + (isRescue(s, j) ? RESCUE_BOOST : 0);
        if (!pick || score > pick.score + 1e-9 || (Math.abs(score - pick.score) < 1e-9 && j.id < pick.job.id))
          pick = {job: j, bid: bids[0], runnerUp: bids[1] || null, regret, score};
      }
      if (!pick) break;
      assignments.push({...pick.bid, regret: pick.regret, score: pick.score, runnerUp: pick.runnerUp?.tractorId || null});
      taken.add(pick.bid.tractorId); awarded.add(pick.job.id);
    }

    // Free tractors that got nothing and were blocked only by fuel → send them to refuel.
    for (const id of fuelBlocked) {
      const t = s.tractors.find(t => t.id === id);
      if (!taken.has(id) && !refuelIds.has(id) && t.fuel < t.capacity - 1) refuels.push({tractorId: id, reason: 'not enough fuel for any open job'});
    }

    // Jobs left open: waiting for a busy tractor, or at risk (no tractor could ever do it in time).
    const waiting = [], atRisk = [];
    for (const j of pending) {
      if (awarded.has(j.id)) continue;
      // Could some non-broken tractor still do it later (after finishing its current job, or after a refuel)?
      const later = s.tractors.filter(t => t.status !== 'broken').map(t => ({t, b: this.bid(s, {...t, fuel: t.capacity}, j, {ignoreBusy: true})}));
      if (later.some(x => x.b.ok)) {
        const who = later.filter(x => x.b.ok).map(x => x.t.id);
        waiting.push({job: j.id, reason: `waiting for ${who.join('/')} (${who.map(id => book[j.id][id].replace('no bid: ', '')).join('; ')})`});
      } else {
        const why = [...new Set(later.map(x => x.b.reason))].join('; ') || 'no working tractor';
        atRisk.push({job: j.id, reason: why});
      }
    }
    return {assignments, refuels, book, waiting, atRisk};
  },
};

// ───────────────────────────── Safety Agent ─────────────────────────────────
export const Safety = {
  review(s, plan) {
    const vetoes = [], seenT = new Set(), seenJ = new Set();
    for (const a of plan.assignments) {
      const t = s.tractors.find(t => t.id === a.tractorId), j = s.jobs.find(j => j.id === a.jobId);
      const veto = (category, reason) => vetoes.push({tractorId: a.tractorId, jobId: a.jobId, category, reason});
      if (!t || !j) { veto('data', 'unknown tractor or job'); continue; }
      if (t.status === 'broken') { veto('broken', `${t.id} is broken and cannot receive work`); continue; }
      if (!isFree(t)) { veto('busy', `${t.id} is already busy (${t.jobId || t.task || t.status})`); continue; }
      if (j.status === 'done') { veto('done', `${j.id} is already DONE; completed work is never reassigned`); continue; }
      if (j.status !== 'pending' || j.tractorId) { veto('duplicate', `${j.id} is already assigned to ${j.tractorId}`); continue; }
      if (seenT.has(t.id)) { veto('duplicate', `${t.id} would receive two jobs`); continue; }
      if (seenJ.has(j.id)) { veto('duplicate', `${j.id} would be assigned to two tractors`); continue; }
      seenT.add(t.id); seenJ.add(j.id);
      if (!compatible(t, j)) { veto('implement', `${t.id} (${t.implements.join('/')}) cannot do ${j.type}`); continue; }
      const leg = Navigation.toJob(s, t, j);
      if (!leg) { veto('route', `no open route from ${t.id} to ${j.fieldId}`); continue; }
      const need = leg.dist * t.travelBurn + remaining(j) * t.workBurn, reserve = Navigation.depotReserve(s, t, leg.dest);
      if (t.fuel < need + reserve - 1e-7) {
        veto('fuel', `${t.id} fuel ${r1(t.fuel)}% < ${r1(need + reserve)}% needed (${r1(need)}% for ${j.id} + ${r1(reserve)}% to return to depot)`);
        continue;
      }
      const start = s.time + leg.travelTime, finish = start + remaining(j);
      // Rescue jobs may finish late (a half-worked field is worse than a late one); everything else must be on time.
      if (finish > j.deadline + 1e-7 && !isRescue(s, j)) { veto('deadline', `${j.id} would finish t=${r1(finish)} after its deadline t=${j.deadline}`); continue; }
      const ag = Agronomy.review(s, j, start, finish);
      if (ag) veto('agronomy', `Agronomy: ${ag}`);
    }
    for (const r of plan.refuels) {
      const t = s.tractors.find(t => t.id === r.tractorId), d = t && Navigation.toDepot(s, t);
      if (!t || !isFree(t)) vetoes.push({tractorId: r.tractorId, jobId: null, category: 'busy', reason: `${r.tractorId} is not free to refuel`});
      else if (!d || d.fuel > t.fuel + 1e-7) vetoes.push({tractorId: t.id, jobId: null, category: 'refuel', reason: `${t.id} cannot reach the depot on ${r1(t.fuel)}% fuel`});
    }
    return {verdict: vetoes.length ? 'VETO' : 'APPROVE', vetoes};
  },

  // Run after every tick. Returns a list of violated invariants (must always be empty).
  invariants(s) {
    const out = [], holders = new Map();
    s._progress ||= {};
    for (const t of s.tractors) {
      if (t.fuel < -1e-7) out.push(`${t.id} has negative fuel`);
      if (!t.jobId) continue;
      const j = s.jobs.find(j => j.id === t.jobId);
      if (!j) { out.push(`${t.id} holds unknown job ${t.jobId}`); continue; }
      if (t.status === 'broken') out.push(`broken ${t.id} still holds ${j.id}`);
      if (!compatible(t, j)) out.push(`${t.id} holds incompatible job ${j.id}`);
      if (j.status === 'done') out.push(`${t.id} holds DONE job ${j.id}`);
      if (j.tractorId !== t.id) out.push(`${j.id} / ${t.id} assignment mismatch`);
      if (holders.has(j.id)) out.push(`${j.id} assigned to both ${holders.get(j.id)} and ${t.id}`);
      holders.set(j.id, t.id);
    }
    for (const j of s.jobs) {
      if (j.progress + 1e-9 < (s._progress[j.id] ?? 0)) out.push(`${j.id} lost progress (${r1(s._progress[j.id] * 100)}% → ${r1(j.progress * 100)}%)`);
      s._progress[j.id] = Math.max(j.progress, s._progress[j.id] ?? 0);
      if (j.status === 'done' && j.progress < 1 - 1e-9) out.push(`${j.id} marked DONE at ${r1(j.progress * 100)}%`);
      if (['assigned', 'in_progress'].includes(j.status) && holders.get(j.id) !== j.tractorId) out.push(`${j.id} is ${j.status} but no tractor holds it`);
    }
    return out;
  },
};

// ───────────────────────────── Orchestrator ─────────────────────────────────
export function describeTrigger(s, tr) {
  const name = id => s.tractors.find(t => t.id === id)?.name || id;
  switch (tr.type) {
    case 'SUBMITTED': return `Job list submitted (${s.jobs.length} jobs)`;
    case 'BREAKDOWN': return tr.jobId ? `BREAKDOWN ${tr.tractorId} (${name(tr.tractorId)}) during ${tr.jobId} (${Math.round(tr.progress * 100)}% done)` : `BREAKDOWN ${tr.tractorId} (${name(tr.tractorId)}) while idle`;
    case 'REPAIRED': return `${tr.tractorId} repaired and back in service`;
    case 'ROUTE_BLOCKED': return `Route blocked at (${tr.x},${tr.y})`;
    case 'ROUTE_REOPENED': return `Route reopened at (${tr.x},${tr.y})`;
    case 'RELEASED': return `${tr.tractorId} released ${tr.jobId}: ${tr.why}`;
    case 'PRIORITY': return `${tr.jobId} priority changed to ${tr.priority}`;
    case 'JOB_ADDED': return `Operator added ${tr.jobId}`;
    case 'JOB_DONE': return `${tr.tractorId} finished ${tr.jobId}`;
    case 'REFUELED': return `${tr.tractorId} refueled`;
    case 'AGRONOMY_WINDOW': return `Agronomy conditions changed at t=${s.time}`;
    case 'OPERATOR_EDIT': return `Operator edited ${tr.id}`;
    default: return tr.type;
  }
}
const ROUTINE = new Set(['JOB_DONE', 'REFUELED', 'AGRONOMY_WINDOW']);

// ── Rescue coordination (HELP_REQUEST → PLEDGE/DECLINE → DESIGNATE → RESCUE → RESCUE_COMPLETE) ──
// When a tractor breaks down mid-field, the Orchestrator asks every other tractor for help. Each one answers
// with a pledge (when it could be free, arrive and finish, including a refuel stop if needed) or a decline.
// Fleet designates the pledge with the earliest finish; the rescue job then goes first in every auction until
// a helper is on its way. If the designated helper breaks down too, the round is repeated.
const RESCUE_EVENTS = new Set(['BREAKDOWN', 'RELEASED', 'REPAIRED', 'ROUTE_BLOCKED', 'ROUTE_REOPENED', 'OPERATOR_EDIT']);
function rescueRound(s, triggers, ctx) {
  s.pledges ||= {};
  const urgent = triggers.some(tr => RESCUE_EVENTS.has(tr.type));
  for (const j of s.jobs) {
    if (!isRescue(s, j) || j.status !== 'pending') continue;
    const p = s.pledges[j.id], pledger = p?.tractorId && s.tractors.find(t => t.id === p.tractorId);
    if (p && !urgent && (p.state === 'stranded' || (pledger && pledger.status !== 'broken'))) continue;
    const r = s.released[j.id], f = fieldOf(s, j), pct = Math.round(j.progress * 100);
    ctx.message(s, 'Orchestrator', 'Tractors', 'HELP_REQUEST', j.id,
      `${r.tractorId} stopped in ${f?.name || j.fieldId} with ${pct}% done. Who can finish the remaining ${100 - pct}% (${r1(remaining(j))} min of ${j.type})?`);
    const answers = s.tractors.filter(t => t.status !== 'broken').map(t => Fleet.pledge(s, t, j));
    for (const a of answers) {
      if (a.ok) ctx.message(s, a.tractorId, 'Fleet', 'PLEDGE', j.id,
        `${a.after ? `after ${a.after} (free t=${r1(a.freeAt)})` : 'free now'}${a.viaDepot ? ', refuel first' : ''}: on site t=${r1(a.arrive)}, field done t=${r1(a.finish)}${a.finish > j.deadline ? ` (${r1(a.finish - j.deadline)} min past deadline)` : ''}`);
      else ctx.message(s, a.tractorId, 'Fleet', 'DECLINE', j.id, a.reason);
    }
    const ok = answers.filter(a => a.ok).sort((a, b) => a.finish - b.finish || a.tractorId.localeCompare(b.tractorId));
    if (!ok.length) {
      s.pledges[j.id] = {state: 'stranded', from: r.tractorId, time: s.time};
      ctx.message(s, 'Orchestrator', 'Operator', 'ESCALATE', j.id, `No tractor can finish ${j.id}: repair ${r.tractorId} or add a ${j.type}-capable tractor. ${pct}% progress is kept.`);
      continue;
    }
    const best = ok[0];
    s.pledges[j.id] = {tractorId: best.tractorId, from: r.tractorId, eta: best.finish, arrive: best.arrive, freeAt: best.freeAt, state: 'pledged', time: s.time};
    ctx.message(s, 'Fleet', best.tractorId, 'DESIGNATE', j.id,
      `${best.tractorId} will rescue ${j.id}: earliest finish t=${r1(best.finish)}${ok[1] ? ` (${r1(ok[1].finish - best.finish)} min ahead of ${ok[1].tractorId})` : ' (only capable helper)'}${best.after ? `, right after ${best.after}` : ', leaving now'}.`);
    s.orchestratorMemory.push({time: s.time, kind: 'rescue_designated', jobId: j.id, tractorId: best.tractorId, from: r.tractorId});
  }
}
function rescueFollowup(s, ctx) {
  s.pledges ||= {};
  for (const [jobId, p] of Object.entries(s.pledges)) {
    const j = s.jobs.find(j => j.id === jobId);
    if (!j) { delete s.pledges[jobId]; continue; }
    if (j.status === 'done') {
      if (p.state === 'en route') ctx.message(s, p.tractorId, 'Orchestrator', 'RESCUE_COMPLETE', jobId, `finished ${jobId} that ${p.from} left behind (t=${s.time}${s.time > j.deadline ? `, ${r1(s.time - j.deadline)} min late` : ', on time'})`);
      delete s.pledges[jobId];
    } else if (j.tractorId && p.state !== 'en route') {
      const f = fieldOf(s, j);
      Object.assign(p, {state: 'en route', tractorId: j.tractorId});
      ctx.message(s, j.tractorId, 'Orchestrator', 'RESCUE', jobId, `heading to ${f?.name || j.fieldId} to finish the remaining ${Math.round((1 - j.progress) * 100)}% of ${jobId} for ${p.from}`);
    } else if (!j.tractorId && p.state === 'en route') {
      // The helper itself dropped the job (breakdown/blocked route): a new help round will run.
      p.state = 'pledged'; p.tractorId = null;
    }
  }
}

// ctx = {message, assign, startRefuel, log} provided by the simulator core.
export function orchestrate(s, triggers, ctx) {
  for (const tr of triggers) if (tr.jobId && ['BREAKDOWN', 'RELEASED'].includes(tr.type)) s.released[tr.jobId] = {tractorId: tr.tractorId, progress: tr.progress, time: tr.time};
  // The "rescue" check must also run on routine triggers: a JOB_DONE frees a pledged helper, and a finished rescue is reported.
  rescueRound(s, triggers, ctx);
  const exp = replan(s, triggers, ctx);
  rescueFollowup(s, ctx);
  return exp;
}

function replan(s, triggers, ctx) {
  const t0 = now();
  const pending = s.jobs.filter(j => j.status === 'pending'), free = s.tractors.filter(isFree);
  const label = triggers.map(tr => describeTrigger(s, tr)).join('; ');
  const routine = triggers.every(tr => ROUTINE.has(tr.type));
  for (const tr of triggers) if (tr.jobId && ['BREAKDOWN', 'RELEASED'].includes(tr.type)) s.released[tr.jobId] = {tractorId: tr.tractorId, progress: tr.progress, time: tr.time};
  if (!pending.length || !free.length) {
    if (!routine && pending.length) ctx.message(s, 'Orchestrator', 'Operator', 'HOLD', null, `${label}. No free tractor right now; ${pending.length} job(s) wait for the next tractor to free up.`);
    return null;
  }

  const before = new Map(s.jobs.filter(j => j.tractorId && j.status !== 'done').map(j => [j.id, j.tractorId]));
  ctx.message(s, 'Orchestrator', 'Fleet', 'REPLAN_REQUEST', null, `${label}. ${pending.length} open job(s), ${free.length} free tractor(s).`);
  ctx.message(s, 'Fleet', 'Tractors', 'CALL_FOR_PROPOSALS', null, pending.map(j => `${j.id}(${j.type}, p${j.priority}, due t=${j.deadline})`).join(', '));

  const excluded = new Map(), refuelWanted = new Set(), vetoLog = [];
  let plan = null, approved = false, rounds = 0;
  const version = (s.planVersion || 0) + 1;
  while (rounds < MAX_ROUNDS) {
    rounds++;
    plan = Fleet.propose(s, excluded, refuelWanted);
    for (const a of plan.assignments) ctx.message(s, a.tractorId, 'Fleet', 'PROPOSAL', a.jobId, `cost ${r1(a.cost)}: travel ${r1(a.travelTime)} min, fuel ${r1(a.required)}%, ETA t=${r1(a.finish)}`);
    const summary = [...plan.assignments.map(a => `${a.tractorId}→${a.jobId}`), ...plan.refuels.map(r => `${r.tractorId}→depot`)].join(', ') || 'no changes';
    ctx.message(s, 'Fleet', 'Safety', 'PLAN_PROPOSED', null, `plan v${version} (round ${rounds}): ${summary}`, version);
    const review = Safety.review(s, plan);
    if (review.verdict === 'APPROVE') {
      ctx.message(s, 'Safety', 'Fleet', 'APPROVE', null, `plan v${version}: implements, fuel reserve, deadlines, uniqueness and agronomy rules all pass`, version);
      approved = true;
      break;
    }
    for (const v of review.vetoes) {
      ctx.message(s, 'Safety', 'Fleet', 'VETO', v.jobId, v.reason, version);
      vetoLog.push(v);
      if (v.jobId) excluded.set(pairKey(v.tractorId, v.jobId), v.reason);
      if (v.category === 'fuel') refuelWanted.add(v.tractorId);
    }
    const fixes = review.vetoes.map(v => v.category === 'fuel' ? `send ${v.tractorId} to refuel` : v.jobId ? `drop ${v.tractorId}→${v.jobId}` : `cancel ${v.tractorId} refuel`);
    ctx.message(s, 'Fleet', 'Safety', 'REVISE', null, `revising: ${fixes.join(', ')}`, version);
    if (review.vetoes.some(v => !v.jobId)) plan.refuels = []; // never retry an unsafe refuel
  }
  if (approved && !plan.assignments.length && !plan.refuels.length && !vetoLog.length) {
    // Nothing can change right now (open jobs are waiting for busy tractors): don't bump the plan version.
    for (const [jobId, bids] of Object.entries(plan.book)) s.bids[jobId] = {...(s.bids[jobId] || {}), time: s.time, version: s.planVersion, bids, winner: s.bids[jobId]?.winner || null};
    if (!routine || plan.atRisk.length) ctx.message(s, 'Orchestrator', 'Operator', 'HOLD', null, `${label}. Plan v${s.planVersion} unchanged: ${[...plan.waiting, ...plan.atRisk].map(w => `${w.job} ${w.reason}`).join('; ')}`);
    return null;
  }
  if (!approved) {
    ctx.message(s, 'Orchestrator', 'Operator', 'ESCALATE', null, `No safe plan after ${rounds} rounds; jobs stay pending for operator review.`);
    return null;
  }

  // Commit plan vN+1.
  s.planVersion = version;
  for (const a of plan.assignments) {
    const t = s.tractors.find(t => t.id === a.tractorId), j = s.jobs.find(j => j.id === a.jobId);
    if (a.detour) ctx.message(s, 'Navigation', a.tractorId, 'ROUTE', a.jobId, `detour of ${a.path.length} waypoints, ${r1(a.dist)} cells around blocked roads`);
    ctx.assign(s, t, j, {path: a.path, dist: a.dist, finish: a.finish, required: a.required, travelTime: a.travelTime, feasible: true});
  }
  for (const r of plan.refuels) ctx.startRefuel(s, s.tractors.find(t => t.id === r.tractorId), r.reason);
  for (const [jobId, bids] of Object.entries(plan.book)) {
    const a = plan.assignments.find(a => a.jobId === jobId);
    s.bids[jobId] = {time: s.time, version, bids, winner: a?.tractorId || null, regret: a ? r1(a.regret) : null, runnerUp: a?.runnerUp || null,
      vetoes: vetoLog.filter(v => v.jobId === jobId).map(v => `${v.tractorId}: ${v.reason}`)};
  }

  // Diff vN → vN+1 for the Explainer.
  // Jobs handed off by a broken/blocked tractor stay in s.released until someone picks them up.
  const released = new Map(Object.entries(s.released));
  const describeJob = j => `${j.id} ${j.type} ${fieldOf(s, j)?.name || j.fieldId}${j.progress > 0 ? ` (remaining ${Math.round((1 - j.progress) * 100)}%)` : ''}`;
  const moved = [], assigned = [];
  for (const a of plan.assignments) {
    const j = s.jobs.find(j => j.id === a.jobId), t = s.tractors.find(t => t.id === a.tractorId);
    const reason = `${a.runnerUp ? `beat ${a.runnerUp} by ${r1(a.regret)} min` : 'only valid bidder'}; fuel ${r1(t.fuel)}%, ETA t=${r1(a.finish)}, deadline t=${j.deadline}`;
    if (released.has(j.id)) { moved.push({job: describeJob(j), from: released.get(j.id).tractorId, to: t.id, kept: `${Math.round(released.get(j.id).progress * 100)}% kept`, reason}); delete s.released[j.id]; }
    else assigned.push({job: describeJob(j), to: t.id, reason});
  }
  const touched = moved.length + assigned.length;
  const diff = {
    version, time: s.time, trigger: label, moved, assigned,
    refuels: plan.refuels.map(r => ({tractor: r.tractorId, reason: r.reason})),
    vetoes: vetoLog.map(v => `${v.tractorId}${v.jobId ? '→' + v.jobId : ''}: ${v.reason}`),
    unchanged: before.size, touched, total: s.jobs.filter(j => j.status !== 'done').length,
    waiting: plan.waiting, at_risk: plan.atRisk,
    lost_from: Object.keys(s.released),
  };
  const ms = now() - t0;
  s.agentStats.replans++; s.agentStats.vetoes += vetoLog.length; s.agentStats.refuels += plan.refuels.length; s.agentStats.latencyMs += ms;
  s.plans.push({version, time: s.time, trigger: label, assignments: plan.assignments.map(a => ({tractor: a.tractorId, job: a.jobId, eta: r1(a.finish)})), refuels: diff.refuels, rounds, ms: r1(ms)});
  const text = templateExplain(diff);
  const exp = {id: s.explanations.length + 1, version, time: s.time, diff, text, template: text, source: 'template'};
  s.explanations.push(exp);
  ctx.message(s, 'Explainer', 'Operator', 'EXPLANATION', null, text, version);
  return exp;
}

// Plain-language fallback (also the prompt "ground truth" for the LLM).
export function templateExplain(d) {
  const parts = [`Plan v${d.version} (${d.trigger}).`];
  for (const m of d.moved) parts.push(`${m.job} moves from ${m.from} to ${m.to} (${m.kept}, no work lost): ${m.reason}.`);
  for (const a of d.assigned) parts.push(`${a.to} takes ${a.job}: ${a.reason}.`);
  for (const r of d.refuels) parts.push(`${r.tractor} goes to the depot to refuel first (${r.reason}).`);
  if (d.vetoes.length) parts.push(`Safety vetoed ${d.vetoes.length} option(s) before approving: ${d.vetoes[0]}${d.vetoes.length > 1 ? '; …' : ''}.`);
  for (const id of d.lost_from) parts.push(`${id} has no free compatible tractor yet; its progress is kept and it waits in the queue.`);
  for (const r of d.at_risk) parts.push(`⚠ ${r.job} is at risk and needs operator attention: ${r.reason}.`);
  parts.push(`Replan touched ${d.touched} of ${d.total} open jobs; ${d.unchanged} in-flight assignment(s) unchanged.`);
  return parts.join(' ');
}

// Facts for "why?" questions. If the question names another tractor ("why not T3?"),
// force that alternative through the Fleet bid + Safety rules and report the result as what_if.
export function whyFacts(s, jobId, question = '') {
  const j = s.jobs.find(j => j.id === jobId);
  if (!j) return null;
  const f = fieldOf(s, j), rec = s.bids[jobId];
  const facts = {
    job: `${j.id} ${j.type} on ${f?.name || j.fieldId}, priority ${j.priority}, deadline t=${j.deadline}, ${Math.round(j.progress * 100)}% done, status ${j.status}`,
    assignment: j.tractorId ? `${j.tractorId} (${j.status})` : 'unassigned',
    auction: rec ? {at: `t=${rec.time}, plan v${rec.version}`, winner: rec.winner, runner_up: rec.runnerUp, regret_min: rec.regret, bids: rec.bids} : 'not auctioned yet',
    safety: rec?.vetoes?.length ? rec.vetoes : 'approved with no vetoes',
    now: `t=${s.time}`,
  };
  const alt = (question.match(/\bT\d+\b/i) || [])[0]?.toUpperCase();
  if (alt && alt !== j.tractorId) {
    const t = s.tractors.find(t => t.id === alt);
    if (t) {
      const b = Fleet.bid(s, t, j, {ignoreBusy: true});
      let result;
      if (!b.ok) result = `rejected: ${b.reason}`;
      else {
        const reserve = Navigation.depotReserve(s, t, center(f));
        const extra = [];
        if (t.fuel < b.required + reserve) extra.push(`Safety would veto: fuel ${r1(t.fuel)}% < ${r1(b.required + reserve)}% incl. depot reserve`);
        if (!isFree(t)) extra.push(`but it is currently ${t.jobId ? 'busy with ' + t.jobId : t.status}`);
        result = `could finish at t=${r1(b.finish)} with travel ${r1(b.travelTime)} min (cost ${r1(b.cost)})${extra.length ? '; ' + extra.join('; ') : ''}`;
      }
      facts.what_if = {[`${alt} instead`]: result};
    }
  }
  const lines = [`${j.id}: ${facts.assignment}.`];
  if (rec) lines.push(`At t=${rec.time} ${rec.winner || 'no tractor'} won the auction${rec.runnerUp ? ` (next best ${rec.runnerUp}, ${rec.regret} min worse)` : ''}.`,
    'Bids: ' + Object.entries(rec.bids).map(([k, v]) => `${k} ${v}`).join('; ') + '.');
  if (facts.what_if) lines.push(`What if ${alt}? ${Object.values(facts.what_if)[0]}.`);
  return {facts, template: lines.join(' ')};
}
