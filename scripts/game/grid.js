// Cell grid shared by procgen, collision, pathfinding and AI.
// Cells are CELL x CELL metres. Walls live on cell edges:
//   hWall[y * w + x]        edge on the north side of cell (x, y), y in [0, h]
//   vWall[y * (w + 1) + x]  edge on the west side of cell (x, y),  x in [0, w]
// Pillars live on cell corners: pillar[j * (w + 1) + i].

export const CELL = 3;
export const WALL_HEIGHT = 2.9;
export const WALL_THICKNESS = 0.2;
export const PILLAR_SIZE = 0.6;

// N, E, S, W
export const DIRS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
];

export function createGrid(w, h) {
  return {
    w,
    h,
    solid: new Uint8Array(w * h),
    zone: new Uint8Array(w * h),
    hWall: new Uint8Array(w * (h + 1)).fill(1),
    vWall: new Uint8Array((w + 1) * h).fill(1),
    pillar: new Uint8Array((w + 1) * (h + 1)),
  };
}

export function inBounds(g, x, y) {
  return x >= 0 && y >= 0 && x < g.w && y < g.h;
}

export function edgeRef(g, x, y, dir) {
  switch (dir) {
    case 0:
      return { arr: g.hWall, i: y * g.w + x };
    case 2:
      return { arr: g.hWall, i: (y + 1) * g.w + x };
    case 3:
      return { arr: g.vWall, i: y * (g.w + 1) + x };
    default:
      return { arr: g.vWall, i: y * (g.w + 1) + x + 1 };
  }
}

export function hasWall(g, x, y, dir) {
  const e = edgeRef(g, x, y, dir);
  return e.arr[e.i] === 1;
}

export function setWall(g, x, y, dir, value) {
  const e = edgeRef(g, x, y, dir);
  e.arr[e.i] = value ? 1 : 0;
}

export function isBorderEdge(g, x, y, dir) {
  const nx = x + DIRS[dir].dx;
  const ny = y + DIRS[dir].dy;
  return !inBounds(g, nx, ny);
}

export function canMove(g, x, y, dir) {
  const nx = x + DIRS[dir].dx;
  const ny = y + DIRS[dir].dy;
  if (!inBounds(g, nx, ny)) return false;
  if (g.solid[ny * g.w + nx]) return false;
  return !hasWall(g, x, y, dir);
}

export function openCount(g, x, y) {
  let n = 0;
  for (let d = 0; d < 4; d++) if (canMove(g, x, y, d)) n++;
  return n;
}

export function cellCenter(g, x, y) {
  return { x: (x - g.w / 2 + 0.5) * CELL, z: (y - g.h / 2 + 0.5) * CELL };
}

export function cellX(g, wx) {
  return Math.floor(wx / CELL + g.w / 2);
}

export function cellY(g, wz) {
  return Math.floor(wz / CELL + g.h / 2);
}

export function worldToCell(g, wx, wz) {
  const x = Math.min(g.w - 1, Math.max(0, cellX(g, wx)));
  const y = Math.min(g.h - 1, Math.max(0, cellY(g, wz)));
  return { x, y };
}

export function worldToIndex(g, wx, wz) {
  const c = worldToCell(g, wx, wz);
  return c.y * g.w + c.x;
}

// World coordinate of the corner (i, j), i in [0, w], j in [0, h].
export function cornerWorld(g, i, j) {
  return { x: (i - g.w / 2) * CELL, z: (j - g.h / 2) * CELL };
}
