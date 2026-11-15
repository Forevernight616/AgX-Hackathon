<script setup>
// Farm map: roads, farm lanes (field gates), fields with live coverage plans, and tractors that are
// animated along the exact vertices they drove each tick (roads, lanes, headland laps, passes, U-turns).
import {ref, watch, onMounted, onUnmounted} from 'vue';
import {fieldGates, nearestCorner, distance} from '../engine/nav.js';
import {coveragePlan, splitPlan, pointAt} from '../engine/coverage.js';

const props = defineProps({sim: Object, selected: Object, blockMode: Boolean, tickMs: {type: Number, default: 550}, fieldColor: Object});
const emit = defineEmits(['select', 'cell']);
const C = 50, px = v => v * C + C / 2;
const pts = list => list.map(p => `${px(p.x)},${px(p.y)}`).join(' ');

// ── Smooth animation along the per-tick trail ──
const now = ref(performance.now());
let anim = {}, headings = {}, lastProgress = {}, animEnd = 0, raf = 0;
function frame() { const t = performance.now(); if (t < animEnd + 40) now.value = t; raf = requestAnimationFrame(frame); }
onMounted(() => { raf = requestAnimationFrame(frame); });
onUnmounted(() => cancelAnimationFrame(raf));

function polyline(list) {
  const cum = [0];
  for (let i = 1; i < list.length; i++) cum.push(cum[i - 1] + distance(list[i - 1], list[i]));
  return {list, cum, total: cum.at(-1) || 0};
}
function at(poly, s) {
  const {list, cum} = poly;
  if (list.length < 2 || poly.total < 1e-9) return {x: list.at(-1).x, y: list.at(-1).y, i: list.length - 1, dir: null};
  let i = 1;
  while (i < list.length - 1 && cum[i] < s) i++;
  const a = list[i - 1], b = list[i], seg = cum[i] - cum[i - 1], k = seg > 1e-9 ? Math.min(1, Math.max(0, (s - cum[i - 1]) / seg)) : 1;
  return {x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, i, dir: seg > 1e-6 ? Math.atan2(b.y - a.y, b.x - a.x) : null};
}
const frac = a => Math.min(1, Math.max(0, (now.value - a.start) / a.dur));

function pose(t) {
  const a = anim[t.id];
  let p = {x: t.x, y: t.y, dir: null};
  if (a && a.poly.total > 1e-9) p = at(a.poly, frac(a) * a.poly.total);
  if (p.dir != null) headings[t.id] = p.dir;
  return {x: p.x, y: p.y, deg: (headings[t.id] ?? -Math.PI / 2) * 180 / Math.PI};
}
// What the tractor still has to drive: rest of this tick's animation, then its planned path.
function remainingRoute(t) {
  const a = anim[t.id], here = pose(t), rest = [];
  if (a && a.poly.total > 1e-9 && frac(a) < 1) {
    const p = at(a.poly, frac(a) * a.poly.total);
    rest.push(...a.poly.list.slice(p.i));
  }
  return [here, ...rest, ...t.path];
}

watch(() => [props.sim, props.sim.time], ([s, nt], [ps, ot] = []) => {
  const fresh = s !== ps || ot == null || nt < ot;
  const start = performance.now();
  if (fresh) { anim = {}; headings = {}; }
  for (const t of s.tractors) {
    if (fresh) continue;
    const a = anim[t.id], list = [];
    if (a && a.poly.total > 1e-9 && frac(a) < 1) {
      const p = at(a.poly, frac(a) * a.poly.total);
      list.push({x: p.x, y: p.y}, ...a.poly.list.slice(p.i));
    } else list.push(a ? a.poly.list.at(-1) : {x: t.x, y: t.y});
    for (const q of t.trail || []) if (q.time > ot && q.time <= nt) list.push(q);
    list.push({x: t.x, y: t.y});
    anim[t.id] = {poly: polyline(list), start, dur: props.tickMs * 0.97};
  }
  // Coverage progress interpolates in step with the tractor that is working the field.
  for (const j of s.jobs) {
    const p0 = fresh ? j.progress : (lastProgress[j.id] ?? j.progress);
    anim['job:' + j.id] = {p0, p1: j.progress, start, dur: props.tickMs * 0.97};
    lastProgress[j.id] = j.progress;
  }
  animEnd = start + props.tickMs;
  now.value = start;
}, {immediate: true});

// ── Static map features ──
function lanes() {
  const gates = fieldGates(props.sim), out = [];
  for (const list of Object.values(gates)) for (const g of list) {
    out.push({id: `${g.fieldId}-${g.road.x},${g.road.y}`, line: [g.road, ...[...g.lane].reverse(), g.edge], edge: g.edge, vertical: g.edge.x === Math.round(g.edge.x)});
  }
  return out;
}

// ── Coverage overlays ──
const TYPE_STYLE = {harvest: {cut: '#eadc9f', alpha: .78, label: 'HARVEST'}, mow: {cut: '#c4e79c', alpha: .7, label: 'MOW'}, spray: {cut: '#6fc8e3', alpha: .5, label: 'SPRAY'}};
const chevronCache = new Map();
function chevrons(plan) {
  const id = `${plan.fieldId}|${plan.type}|${plan.corner}`;
  if (chevronCache.has(id)) return chevronCache.get(id);
  const poly = polyline(plan.points), out = [], step = 0.5;
  for (let s = step * 0.6; s < poly.total - 0.05; s += step) { const p = at(poly, s); out.push({s, x: p.x, y: p.y, deg: (p.dir ?? 0) * 180 / Math.PI}); }
  chevronCache.set(id, out);
  return out;
}
function stageLabel(plan, frac) {
  const i = pointAt(plan, frac).index, lapEnd = 1 + 5 * plan.laps;
  if (i <= lapEnd) return `Headland lap ${Math.min(plan.laps, Math.max(1, Math.ceil((i - 1) / 5)))}/${plan.laps}`;
  return `Pass ${Math.min(plan.passes, Math.floor((i - lapEnd - 1) / 9) + 1)}/${plan.passes}`;
}
function overlays() {
  const s = props.sim, out = [];
  for (const f of s.fields) {
    const jobs = s.jobs.filter(j => j.fieldId === f.id && j.status !== 'done');
    const j = jobs.find(j => j.status === 'in_progress') || jobs.find(j => j.status === 'assigned') || jobs.find(j => j.progress > 0);
    if (!j) continue;
    const t = s.tractors.find(t => t.id === j.tractorId);
    let corner = j.anchor;
    if (corner == null) { const end = t?.path?.at(-1); corner = end ? nearestCorner(f, end) : 3; }
    const plan = coveragePlan(f, j.type, corner), a = anim['job:' + j.id];
    const progress = a ? a.p0 + (a.p1 - a.p0) * frac(a) : j.progress;
    const split = splitPlan(plan, progress), sDone = progress * plan.total;
    const preview = j.status !== 'in_progress';
    const arrows = chevrons(plan).filter(c => c.s > sDone + 0.15).map(c => ({...c, near: c.s - sDone < 2.4}));
    out.push({
      f, j, plan, preview, color: t?.color || '#e9f1dc', style: TYPE_STYLE[j.type] || TYPE_STYLE.harvest,
      done: progress > 0 ? split.done : [], todo: split.todo, arrows, start: plan.points[0], end: plan.points.at(-1),
      label: `${(TYPE_STYLE[j.type] || TYPE_STYLE.harvest).label} ${Math.round(j.progress * 100)}% · ${preview ? (j.status === 'assigned' ? 'planned' : 'paused') : stageLabel(plan, progress)}`,
    });
  }
  return out;
}
const isSel = (kind, id) => props.selected.kind === kind && props.selected.id === id;
function onBlockClick(e) {
  const p = e.currentTarget.ownerSVGElement.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
  const q = p.matrixTransform(e.currentTarget.getScreenCTM().inverse());
  emit('cell', Math.floor(q.x / C), Math.floor(q.y / C));
}
const swathPx = (t, plan) => plan ? Math.max(14, plan.swath * C * 0.95) : 0;
function workPlan(t) {
  if (t.status !== 'working' || !t.jobId) return null;
  const j = props.sim.jobs.find(j => j.id === t.jobId), f = j && props.sim.fields.find(f => f.id === j.fieldId);
  return f && j.anchor != null ? coveragePlan(f, j.type, j.anchor) : null;
}
const jobType = t => props.sim.jobs.find(j => j.id === t.jobId)?.type;
</script>

<template>
<svg class="farm-map" :viewBox="`0 0 ${sim.width*C} ${sim.height*C}`" role="img" aria-label="Interactive farm map with tractors, roads, farm lanes and field coverage plans">
  <defs>
    <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M 50 0 L 0 0 0 50" fill="none" stroke="#526452" stroke-opacity=".21" stroke-width="1"/></pattern>
    <pattern id="crop" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M 4 3 L 16 17" stroke="#fff" stroke-opacity=".08" stroke-width="2"/></pattern>
    <filter id="shadow"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-opacity=".45"/></filter>
    <clipPath v-for="f in sim.fields" :id="'clip-'+f.id" :key="'clip'+f.id"><rect :x="f.x*C+4" :y="f.y*C+4" :width="f.w*C-8" :height="f.h*C-8" rx="5"/></clipPath>
  </defs>
  <rect :width="sim.width*C" :height="sim.height*C" fill="#24382f"/>
  <rect :width="sim.width*C" :height="sim.height*C" fill="url(#grid)"/>

  <!-- Roads -->
  <g v-for="(r,i) in sim.roads" :key="'road'+i">
    <rect :x="r.x*C" :y="r.y*C" :width="r.w*C" :height="r.h*C" fill="#526057" opacity=".7"/>
    <path v-if="r.w>r.h" :d="`M ${r.x*C} ${r.y*C+25} h ${r.w*C}`" stroke="#a7b5a2" stroke-width="1.4" stroke-dasharray="10 12" opacity=".38"/>
    <path v-else :d="`M ${r.x*C+25} ${r.y*C} v ${r.h*C}`" stroke="#a7b5a2" stroke-width="1.4" stroke-dasharray="10 12" opacity=".38"/>
  </g>
  <!-- Farm lanes from the road to each field gate -->
  <g v-for="l in lanes()" :key="l.id" class="farm-lane">
    <polyline :points="pts(l.line)" fill="none" stroke="#6e5f45" stroke-width="18" stroke-linecap="butt" opacity=".85"/>
    <polyline :points="pts(l.line)" fill="none" stroke="#8d7b5a" stroke-width="2" stroke-dasharray="3 7" opacity=".7"/>
    <g :transform="`translate(${px(l.edge.x)},${px(l.edge.y)})`">
      <rect v-if="l.vertical" x="-12" y="-2" width="24" height="4" rx="1" fill="#c9b48a" opacity=".9"/>
      <rect v-else x="-2" y="-12" width="4" height="24" rx="1" fill="#c9b48a" opacity=".9"/>
    </g>
  </g>

  <!-- Fields -->
  <g v-for="f in sim.fields" :key="f.id" class="map-click" @click="emit('select','field',f.id)">
    <rect :x="f.x*C+4" :y="f.y*C+4" :width="f.w*C-8" :height="f.h*C-8" rx="5" :fill="fieldColor[f.crop]" stroke="#a9bb85" stroke-opacity=".42"/>
    <rect :x="f.x*C+4" :y="f.y*C+4" :width="f.w*C-8" :height="f.h*C-8" rx="5" fill="url(#crop)"/>
    <rect v-if="isSel('field',f.id)" :x="f.x*C+3" :y="f.y*C+3" :width="f.w*C-6" :height="f.h*C-6" rx="6" fill="none" stroke="#9ec7ff" stroke-width="3"/>
  </g>
  <!-- Coverage plans: worked swaths behind the tractor, arrows for the passes still to drive -->
  <g v-for="o in overlays()" :key="'cov'+o.j.id" :clip-path="`url(#clip-${o.f.id})`" class="coverage" :opacity="o.preview?.55:1">
    <polyline v-if="o.done.length>1" :points="pts(o.done)" fill="none" :stroke="o.style.cut" :stroke-width="o.plan.swath*C*.98" stroke-linejoin="round" stroke-linecap="round" :opacity="o.style.alpha"/>
    <polyline :points="pts(o.todo)" fill="none" stroke="#f4f7e8" stroke-width="1.1" stroke-dasharray="2 4" opacity=".35"/>
    <path v-for="(c,i) in o.arrows" :key="i" d="M -3.5 -4 L 2.5 0 L -3.5 4" fill="none" :stroke="c.near?o.color:'#f4f7e8'" :stroke-width="c.near?2.2:1.5" stroke-linecap="round" stroke-linejoin="round" :opacity="c.near?.95:.5" :transform="`translate(${px(c.x)},${px(c.y)}) rotate(${c.deg})`"/>
    <circle :cx="px(o.start.x)" :cy="px(o.start.y)" r="4" fill="none" stroke="#f4f7e8" stroke-width="1.5" opacity=".8"/>
    <rect :x="px(o.end.x)-3.5" :y="px(o.end.y)-3.5" width="7" height="7" fill="#f4f7e8" opacity=".75"/>
  </g>
  <g v-for="f in sim.fields" :key="'lbl'+f.id">
    <text :x="f.x*C+14" :y="f.y*C+(f.h>1?25:22)" class="field-label">{{f.name.toUpperCase()}}</text>
    <text v-if="f.h>1" :x="f.x*C+14" :y="f.y*C+42" class="field-sub">{{f.id}} · {{f.crop}}</text>
  </g>
  <g v-for="o in overlays()" :key="'badge'+o.j.id" class="coverage-badge">
    <rect :x="o.f.x*C+8" :y="(o.f.y+o.f.h)*C-24" :width="Math.min(o.f.w*C-16, o.label.length*5.6+14)" height="16" rx="4" fill="#13221d" opacity=".82"/>
    <text :x="o.f.x*C+15" :y="(o.f.y+o.f.h)*C-12.5" class="coverage-text" :fill="o.style.cut">{{o.label}}</text>
  </g>

  <!-- Depot + obstacles -->
  <g class="map-click" @click="emit('select','field','station')">
    <rect :x="sim.station.x*C+8" :y="sim.station.y*C+8" width="34" height="34" rx="6" fill="#1b615d" stroke="#70c8be"/>
    <text :x="sim.station.x*C+25" :y="sim.station.y*C+31" text-anchor="middle" font-size="21">⛽</text>
  </g>
  <g v-for="o in sim.obstacles" :key="`o${o.x},${o.y}`">
    <rect :x="o.x*C+5" :y="o.y*C+5" width="40" height="40" rx="5" fill="#853e3c" stroke="#f18c7c"/>
    <path :d="`M ${o.x*C+16} ${o.y*C+16} l 18 18 m 0 -18 l -18 18`" stroke="#ffd1ca" stroke-width="3"/>
  </g>

  <!-- Planned road routes -->
  <polyline v-for="t in sim.tractors.filter(t=>t.path.length)" :key="'route'+t.id" :points="pts(remainingRoute(t))" fill="none" :stroke="t.color" stroke-width="3" stroke-dasharray="8 6" stroke-linejoin="round" opacity=".9"/>

  <!-- Tractors (top-down, rotated to heading) -->
  <g v-for="t in sim.tractors" :key="t.id" class="map-click tractor-glyph" :transform="`translate(${px(pose(t).x)},${px(pose(t).y)})`" @click="emit('select','tractor',t.id)">
    <circle r="21" :fill="t.status==='broken'?'#7a4545':'#172d29'" fill-opacity=".72" :stroke="isSel('tractor',t.id)?'#fff':t.color" :stroke-width="isSel('tractor',t.id)?3:2" filter="url(#shadow)"/>
    <g :transform="`rotate(${pose(t).deg})`">
      <!-- implement: header/mower bar ahead, spray boom behind; width = planned swath -->
      <rect v-if="workPlan(t)&&jobType(t)!=='spray'" x="10" :y="-swathPx(t,workPlan(t))/2" width="4" :height="swathPx(t,workPlan(t))" rx="1.5" fill="#f1d27a"/>
      <rect v-if="workPlan(t)&&jobType(t)==='spray'" x="-15" :y="-swathPx(t,workPlan(t))/2" width="2.5" :height="swathPx(t,workPlan(t))" rx="1" fill="#8fdcf0"/>
      <rect x="-10" y="-11" width="7" height="5" rx="1.5" fill="#101c1e"/><rect x="-10" y="6" width="7" height="5" rx="1.5" fill="#101c1e"/>
      <rect x="4" y="-9" width="5" height="3.5" rx="1" fill="#101c1e"/><rect x="4" y="5.5" width="5" height="3.5" rx="1" fill="#101c1e"/>
      <rect x="-11" y="-6" width="21" height="12" rx="3" :fill="t.status==='broken'?'#b96a62':t.color"/>
      <rect x="-8" y="-4.5" width="8" height="9" rx="1.5" fill="#223b3c"/>
      <path d="M 10 -3 L 14 0 L 10 3 Z" :fill="t.status==='broken'?'#b96a62':t.color"/>
    </g>
    <text y="-27" text-anchor="middle" class="tractor-label">{{t.id}}</text>
  </g>
  <rect v-if="blockMode" :width="sim.width*C" :height="sim.height*C" fill="transparent" style="cursor:crosshair" @click="onBlockClick"/>
</svg>
</template>

<style scoped>
.coverage, .coverage-badge, .farm-lane { pointer-events: none; }
.coverage-text { font: 700 9.5px 'Space Grotesk', 'DM Sans', sans-serif; letter-spacing: .5px; }
</style>
