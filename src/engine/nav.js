// Shared geometry + path-finding primitives used by the simulator and the Navigation Agent.
//
// Tractors drive on the road network only. Each field is reached through one or more *gates*:
// a short, straight farm lane from a road cell to a field corner. A route is therefore
//   current position → (exit own field via a gate | snap onto road) → shortest road path (Dijkstra,
//   blocked cells excluded) → gate lane → field edge → coverage start corner inside the field.
export const key = (x, y) => `${x},${y}`;
export const center = f => ({x: Math.floor(f.x + (f.w - 1) / 2), y: Math.floor(f.y + (f.h - 1) / 2)});
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const compatibility = {harvester: ['harvest'], sprayer: ['spray'], mower: ['mow'], multi: ['harvest', 'spray', 'mow']};
export const compatible = (t, j) =>
  (t.implements || []).some(i => (compatibility[i] || []).includes(j.type)) || (t.capabilities || []).includes(j.type);

// Inset (cells) of the point where a tractor parks inside a field corner before starting coverage.
export const ANCHOR_INSET = 0.22;
// Routing cost multiplier for leaving the road onto the grass verge (detours around blockages only).
export const OFFROAD_COST = 6;
const inField = (f, x, y) => x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h;
// Continuous containment: tractor coordinates are cell centres, so a field spans [x-0.5, x+w-0.5].
export const insideField = (f, p) => p.x >= f.x - 0.5 - 1e-6 && p.x <= f.x + f.w - 0.5 + 1e-6 && p.y >= f.y - 0.5 - 1e-6 && p.y <= f.y + f.h - 0.5 + 1e-6;
// The four field corners in continuous coordinates, in a fixed order (0 TL, 1 TR, 2 BR, 3 BL).
export const corners = f => [
  {x: f.x - 0.5, y: f.y - 0.5}, {x: f.x + f.w - 0.5, y: f.y - 0.5},
  {x: f.x + f.w - 0.5, y: f.y + f.h - 0.5}, {x: f.x - 0.5, y: f.y + f.h - 0.5},
];
export const nearestCorner = (f, p) => {
  const c = corners(f);
  let best = 0;
  for (let i = 1; i < 4; i++) if (distance(c[i], p) < distance(c[best], p) - 1e-9) best = i;
  return best;
};
export function anchorPoint(f, corner, inset = ANCHOR_INSET) {
  const c = corners(f)[corner], sx = corner === 0 || corner === 3 ? 1 : -1, sy = corner <= 1 ? 1 : -1;
  return {x: c.x + sx * inset, y: c.y + sy * inset};
}

function roadSet(s) {
  const set = new Set();
  for (const r of s.roads || []) for (let x = r.x; x < r.x + r.w; x++) for (let y = r.y; y < r.y + r.h; y++) set.add(key(x, y));
  return set;
}

// Static field access (ignores obstacles, which are dynamic and checked at routing time).
// Per field side, prefer a lane from a corner cell; otherwise the edge cell closest to a corner.
// Keeps only gates whose lane is at most one cell longer than the shortest one.
const gateCache = new WeakMap();
export function fieldGates(s) {
  const cached = gateCache.get(s.fields);
  if (cached && cached.roads === s.roads) return cached.gates;
  const roads = roadSet(s), gates = {};
  const occupied = (x, y) => s.fields.some(f => inField(f, x, y));
  for (const f of s.fields) {
    const sides = [
      {dx: 0, dy: -1, cells: [...Array(f.w)].map((_, i) => ({x: f.x + i, y: f.y}))},
      {dx: 0, dy: 1, cells: [...Array(f.w)].map((_, i) => ({x: f.x + i, y: f.y + f.h - 1}))},
      {dx: -1, dy: 0, cells: [...Array(f.h)].map((_, i) => ({x: f.x, y: f.y + i}))},
      {dx: 1, dy: 0, cells: [...Array(f.h)].map((_, i) => ({x: f.x + f.w - 1, y: f.y + i}))},
    ];
    const found = [];
    for (const side of sides) {
      const n = side.cells.length;
      // Order: both corners first, then inwards from the corners.
      const order = [...side.cells.keys()].sort((a, b) => Math.min(a, n - 1 - a) - Math.min(b, n - 1 - b) || a - b);
      const valid = [];
      for (const i of order) {
        const c = side.cells[i], lane = [];
        let x = c.x + side.dx, y = c.y + side.dy, ok = false;
        while (x >= 0 && y >= 0 && x < s.width && y < s.height) {
          if (roads.has(key(x, y))) { ok = true; break; }
          if (occupied(x, y)) break;
          lane.push({x, y}); x += side.dx; y += side.dy;
        }
        if (!ok) continue;
        const rank = Math.min(i, n - 1 - i);
        if (valid.length && rank > valid[0].rank) break;
        valid.push({rank, cell: c, lane, road: {x, y}, dx: side.dx, dy: side.dy});
      }
      found.push(...valid);
    }
    if (!found.length) { gates[f.id] = []; continue; }
    const min = Math.min(...found.map(g => g.lane.length));
    gates[f.id] = found.filter(g => g.lane.length <= min + 1).map(g => {
      // Field edge point where the lane meets the field, and the corner the tractor parks at.
      const edge = {x: g.cell.x + g.dx * 0.5, y: g.cell.y + g.dy * 0.5};
      const corner = nearestCorner(f, edge);
      return {fieldId: f.id, road: g.road, lane: g.lane, edge, corner, anchor: anchorPoint(f, corner)};
    });
  }
  gateCache.set(s.fields, {roads: s.roads, gates});
  return gates;
}

const fieldAtCenter = (s, p) => s.fields.find(f => { const c = center(f); return c.x === p.x && c.y === p.y; });
const fieldContaining = (s, p) => s.fields.find(f => insideField(f, p));

// Entry legs onto the road graph from an arbitrary position: [{node, cost, prefix}]
function sources(s, p, roads, blocked, gates) {
  const free = (x, y) => roads.has(key(x, y)) && !blocked.has(key(x, y));
  const f = fieldContaining(s, p);
  if (f) {
    // Drive back to a gate along the field, then out along the lane.
    return (gates[f.id] || []).filter(g => free(g.road.x, g.road.y) && !g.lane.some(c => blocked.has(key(c.x, c.y)))).map(g => {
      const prefix = [g.edge, ...g.lane, g.road];
      return {node: key(g.road.x, g.road.y), cost: pathLength(p, prefix), prefix};
    });
  }
  for (const list of Object.values(gates)) for (const g of list) {
    const i = g.lane.findIndex(c => distance(c, p) < 0.75);
    if (i >= 0) {
      const prefix = [...g.lane.slice(i + 1), g.road];
      return [{node: key(g.road.x, g.road.y), cost: pathLength(p, prefix), prefix}];
    }
  }
  const out = [];
  for (const x of new Set([Math.floor(p.x), Math.ceil(p.x)])) for (const y of new Set([Math.floor(p.y), Math.ceil(p.y)])) {
    if (free(x, y)) out.push({node: key(x, y), cost: distance(p, {x, y}), prefix: [{x, y}]});
  }
  if (out.length) return out;
  // Off-road and not in a field (e.g. a newly placed tractor): straight to the nearest open road cell.
  let best = null;
  for (const k of roads) {
    if (blocked.has(k)) continue;
    const [x, y] = k.split(',').map(Number), d = distance(p, {x, y});
    if (!best || d < best.cost - 1e-9) best = {node: k, cost: d, prefix: [{x, y}]};
  }
  return best ? [best] : [];
}

// Legs from the road graph to the destination: [{node, cost, suffix}]
function targets(s, end, roads, blocked, gates) {
  const f = fieldAtCenter(s, end);
  if (f) {
    return (gates[f.id] || []).filter(g => !blocked.has(key(g.road.x, g.road.y)) && !g.lane.some(c => blocked.has(key(c.x, c.y)))).map(g => {
      const suffix = [...[...g.lane].reverse(), g.edge, g.anchor];
      return {node: key(g.road.x, g.road.y), cost: pathLength(g.road, suffix), suffix, corner: g.corner};
    });
  }
  if (roads.has(key(end.x, end.y))) return blocked.has(key(end.x, end.y)) ? [] : [{node: key(end.x, end.y), cost: 0, suffix: []}];
  let best = null;
  for (const k of roads) {
    if (blocked.has(k)) continue;
    const [x, y] = k.split(',').map(Number), d = distance(end, {x, y});
    if (!best || d < best.cost - 1e-9) best = {node: k, cost: d, suffix: [{x: end.x, y: end.y}]};
  }
  return best ? [best] : [];
}

// Simplify a cell path: drop intermediate points on straight segments.
function simplify(start, pts) {
  const out = [];
  for (const p of pts) {
    const prev = out.length ? out.at(-1) : start;
    if (distance(prev, p) < 1e-9) continue;
    const prev2 = out.length > 1 ? out.at(-2) : (out.length ? start : null);
    if (prev2 && out.length) {
      const cross = (prev.x - prev2.x) * (p.y - prev.y) - (prev.y - prev2.y) * (p.x - prev.x);
      const dot = (prev.x - prev2.x) * (p.x - prev.x) + (prev.y - prev2.y) * (p.y - prev.y);
      if (Math.abs(cross) < 1e-9 && dot > 0) { out[out.length - 1] = p; continue; }
    }
    out.push({x: p.x, y: p.y});
  }
  return out;
}

// Road-constrained route. Returns a list of waypoints (excluding the start), or null if unreachable.
export function route(start, end, s) {
  const blocked = new Set((s.obstacles || []).map(o => key(o.x, o.y)));
  if (blocked.has(key(end.x, end.y))) return null;
  const roads = roadSet(s), gates = fieldGates(s);
  // Already inside the destination field: drive straight to the start corner.
  const destField = fieldAtCenter(s, end);
  if (destField && insideField(destField, start)) {
    const a = anchorPoint(destField, nearestCorner(destField, start));
    return distance(start, a) < 1e-9 ? [] : [a];
  }
  if (!destField && distance(start, end) < 1e-9) return [{x: end.x, y: end.y}];
  const src = sources(s, start, roads, blocked, gates), dst = targets(s, end, roads, blocked, gates);
  if (!src.length || !dst.length) return null;
  // Multi-source Dijkstra (4-connected). Roads and farm lanes cost 1 per cell; driving on the grass verge
  // (open ground, never through a field) costs OFFROAD_COST per cell, so it is only used to get around a
  // blocked road when no road alternative exists.
  const lanes = new Set(Object.values(gates).flatMap(list => list.flatMap(g => g.lane.map(c => key(c.x, c.y)))));
  const crop = new Set();
  for (const f of s.fields) for (let x = f.x; x < f.x + f.w; x++) for (let y = f.y; y < f.y + f.h; y++) crop.add(key(x, y));
  const dist = new Map(), prev = new Map(), via = new Map(), open = [];
  for (const so of src) if (!dist.has(so.node) || so.cost < dist.get(so.node)) { dist.set(so.node, so.cost); via.set(so.node, so); prev.set(so.node, null); open.push(so.node); }
  const done = new Set();
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (dist.get(open[i]) < dist.get(open[bi])) bi = i;
    const k = open.splice(bi, 1)[0];
    if (done.has(k)) continue;
    done.add(k);
    const [x, y] = k.split(',').map(Number);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k2 = key(nx, ny);
      if (nx < 0 || ny < 0 || nx >= s.width || ny >= s.height || crop.has(k2) || blocked.has(k2) || done.has(k2)) continue;
      const nd = dist.get(k) + (roads.has(k2) || lanes.has(k2) ? 1 : OFFROAD_COST);
      if (!dist.has(k2) || nd < dist.get(k2) - 1e-9) { dist.set(k2, nd); prev.set(k2, k); via.set(k2, via.get(k)); open.push(k2); }
    }
  }
  let best = null;
  for (const t of dst) if (dist.has(t.node)) { const c = dist.get(t.node) + t.cost; if (!best || c < best.c - 1e-9) best = {c, t}; }
  if (!best) return null;
  const cells = [];
  for (let v = best.t.node; v !== null; v = prev.get(v)) { const [x, y] = v.split(',').map(Number); cells.unshift({x, y}); }
  const so = via.get(best.t.node);
  return simplify(start, [...so.prefix, ...cells.slice(1), ...best.t.suffix]);
}
export const pathLength = (start, path) => path.reduce((acc, p, i) => acc + distance(i ? path[i - 1] : start, p), 0);
