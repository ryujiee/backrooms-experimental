import { DIRS, canMove } from "./grid.js";

// The map is a few thousand cells with uniform edge cost, so plain BFS is both the
// shortest-path algorithm and cheaper than A* bookkeeping at this size.

export function bfsDistances(g, startIndex) {
  const n = g.w * g.h;
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  dist[startIndex] = 0;
  queue[tail++] = startIndex;
  while (head < tail) {
    const cur = queue[head++];
    const x = cur % g.w;
    const y = (cur / g.w) | 0;
    for (let d = 0; d < 4; d++) {
      if (!canMove(g, x, y, d)) continue;
      const ni = (y + DIRS[d].dy) * g.w + x + DIRS[d].dx;
      if (dist[ni] !== -1) continue;
      dist[ni] = dist[cur] + 1;
      queue[tail++] = ni;
    }
  }
  return dist;
}

const scratch = { size: 0, prev: null, queue: null };

// Returns cell indices from start to goal (inclusive), or null when unreachable.
export function findPath(g, startIndex, goalIndex) {
  const n = g.w * g.h;
  if (scratch.size !== n) {
    scratch.size = n;
    scratch.prev = new Int32Array(n);
    scratch.queue = new Int32Array(n);
  }
  const prev = scratch.prev;
  const queue = scratch.queue;
  prev.fill(-2);
  let head = 0;
  let tail = 0;
  prev[startIndex] = -1;
  queue[tail++] = startIndex;
  while (head < tail) {
    const cur = queue[head++];
    if (cur === goalIndex) break;
    const x = cur % g.w;
    const y = (cur / g.w) | 0;
    for (let d = 0; d < 4; d++) {
      if (!canMove(g, x, y, d)) continue;
      const ni = (y + DIRS[d].dy) * g.w + x + DIRS[d].dx;
      if (prev[ni] !== -2) continue;
      prev[ni] = cur;
      queue[tail++] = ni;
    }
  }
  if (prev[goalIndex] === -2) return null;
  const path = [];
  for (let cur = goalIndex; cur !== -1; cur = prev[cur]) path.push(cur);
  return path.reverse();
}

// Cells reachable within maxSteps (used for local searches and noise propagation).
export function cellsWithin(g, startIndex, maxSteps) {
  const out = [];
  const dist = new Map([[startIndex, 0]]);
  const queue = [startIndex];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const dc = dist.get(cur);
    out.push({ index: cur, steps: dc });
    if (dc >= maxSteps) continue;
    const x = cur % g.w;
    const y = (cur / g.w) | 0;
    for (let d = 0; d < 4; d++) {
      if (!canMove(g, x, y, d)) continue;
      const ni = (y + DIRS[d].dy) * g.w + x + DIRS[d].dx;
      if (dist.has(ni)) continue;
      dist.set(ni, dc + 1);
      queue.push(ni);
    }
  }
  return out;
}

// Straight row/column visibility on the cell graph (coarse; procgen only).
export function cellsAligned(g, a, b) {
  const ax = a % g.w;
  const ay = (a / g.w) | 0;
  const bx = b % g.w;
  const by = (b / g.w) | 0;
  if (ax !== bx && ay !== by) return false;
  const dir = ax === bx ? (by > ay ? 2 : 0) : bx > ax ? 1 : 3;
  let x = ax;
  let y = ay;
  while (x !== bx || y !== by) {
    if (!canMove(g, x, y, dir)) return false;
    x += DIRS[dir].dx;
    y += DIRS[dir].dy;
  }
  return true;
}
