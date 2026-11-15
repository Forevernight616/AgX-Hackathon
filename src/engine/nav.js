// Shared geometry + path-finding primitives used by the simulator and the Navigation Agent.
export const key = (x, y) => `${x},${y}`;
export const center = f => ({x: Math.floor(f.x + (f.w - 1) / 2), y: Math.floor(f.y + (f.h - 1) / 2)});
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const compatibility = {harvester: ['harvest'], sprayer: ['spray'], mower: ['mow'], multi: ['harvest', 'spray', 'mow']};
export const compatible = (t, j) =>
  (t.implements || []).some(i => (compatibility[i] || []).includes(j.type)) || (t.capabilities || []).includes(j.type);

// Direct Euclidean route unless an obstacle lies on the segment; otherwise a 4-connected BFS detour.
// Returns a list of waypoints (excluding the start), or null if the destination is unreachable.
export function route(start, end, s) {
  const blocked = new Set((s.obstacles || []).map(o => key(o.x, o.y)));
  if (blocked.has(key(end.x, end.y))) return null;
  const touches = (a, b) => {
    const n = Math.max(1, Math.ceil(distance(a, b) * 8));
    for (let i = 1; i <= n; i++) {
      const x = Math.round(a.x + (b.x - a.x) * i / n), y = Math.round(a.y + (b.y - a.y) * i / n);
      if (blocked.has(key(x, y))) return true;
    }
    return false;
  };
  if (!touches(start, end)) return [{x: end.x, y: end.y}];
  const q = [{x: Math.round(start.x), y: Math.round(start.y)}], prev = new Map([[key(q[0].x, q[0].y), null]]);
  for (let i = 0; i < q.length; i++) {
    const p = q[i], k = key(p.x, p.y);
    if (p.x === end.x && p.y === end.y) {
      const out = [];
      let v = k;
      while (v !== null) { const [x, y] = v.split(',').map(Number); out.unshift({x, y}); v = prev.get(v); }
      return out.slice(1);
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = p.x + dx, y = p.y + dy, k2 = key(x, y);
      if (x >= 0 && y >= 0 && x < s.width && y < s.height && !blocked.has(k2) && !prev.has(k2)) { prev.set(k2, k); q.push({x, y}); }
    }
  }
  return null;
}
export const pathLength = (start, path) => path.reduce((acc, p, i) => acc + distance(i ? path[i - 1] : start, p), 0);
