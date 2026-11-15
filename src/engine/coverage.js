// Field coverage planner: how a tractor works a whole field once it has entered it.
//
// Pattern (standard headland + back-and-forth "lands" pattern used by combines and mowers):
//   1. Start at the corner where the tractor entered (the gate corner).
//   2. Open up the field with 1–2 headland laps around the boundary, so there is room to turn.
//   3. Work the interior in straight passes parallel to the long side, one swath apart,
//      with a U-turn inside the headland at the end of every pass.
// Swath width depends on the implement: a sprayer boom covers about twice a header/mower width.
import {corners, anchorPoint, distance} from './nav.js';

export const SWATH = {harvest: 0.4, mow: 0.45, spray: 0.85};
const cache = new Map();

export function coveragePlan(f, type, corner = 3) {
  const id = `${f.id}|${f.x},${f.y},${f.w},${f.h}|${type}|${corner}`;
  if (cache.has(id)) return cache.get(id);
  const horizontal = f.w >= f.h, Lu = horizontal ? f.w : f.h, Lv = horizontal ? f.h : f.w;
  const n = Math.max(3, Math.round(Lv / (SWATH[type] || 0.4))), ws = Lv / n, laps = n >= 7 ? 2 : 1;
  const O = corners(f)[corner], sx = corner === 0 || corner === 3 ? 1 : -1, sy = corner <= 1 ? 1 : -1;
  const map = (u, v) => horizontal ? {x: O.x + sx * u, y: O.y + sy * v} : {x: O.x + sx * v, y: O.y + sy * u};
  const uv = [];
  for (let i = 0; i < laps; i++) {
    const d = (i + 0.5) * ws;
    uv.push([d, d], [Lu - d, d], [Lu - d, Lv - d], [d, Lv - d], [d, d]);
  }
  const passes = n - 2 * laps, a0 = laps * ws, a1 = Lu - laps * ws, r = ws / 2, segs = 8;
  for (let j = 0; j < passes; j++) {
    const v = (laps + j + 0.5) * ws, fwd = j % 2 === 0, from = fwd ? a0 : a1, to = fwd ? a1 : a0;
    uv.push([from, v], [to, v]);
    if (j < passes - 1) {
      const dir = fwd ? 1 : -1, vc = v + r;
      for (let k = 1; k < segs; k++) { const th = Math.PI * k / segs; uv.push([to + dir * r * Math.sin(th), vc - r * Math.cos(th)]); }
    }
  }
  const points = [anchorPoint(f, corner), ...uv.map(([u, v]) => map(u, v))];
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + distance(points[i - 1], points[i]));
  const plan = {fieldId: f.id, type, corner, points, cum, total: cum.at(-1), swath: ws, laps, passes};
  cache.set(id, plan);
  return plan;
}

// Position after covering `frac` (0..1) of the plan, plus the index of the segment it lies on.
export function pointAt(plan, frac) {
  const target = Math.max(0, Math.min(1, frac)) * plan.total, {points, cum} = plan;
  let i = 1;
  while (i < points.length - 1 && cum[i] < target) i++;
  const seg = cum[i] - cum[i - 1], k = seg > 1e-9 ? (target - cum[i - 1]) / seg : 1;
  const a = points[i - 1], b = points[i];
  return {x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, index: i};
}

// Split the plan at `frac` into the worked polyline and the remaining polyline.
export function splitPlan(plan, frac) {
  const p = pointAt(plan, frac), here = {x: p.x, y: p.y};
  return {done: [...plan.points.slice(0, p.index), here], todo: [here, ...plan.points.slice(p.index)], here};
}

// Vertices of the plan strictly between two progress fractions (for smooth animation trails).
export function verticesBetween(plan, from, to) {
  const a = from * plan.total, b = to * plan.total;
  return plan.points.filter((_, i) => plan.cum[i] > a + 1e-9 && plan.cum[i] < b - 1e-9);
}
