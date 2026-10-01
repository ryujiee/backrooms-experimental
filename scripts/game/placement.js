import { CELL, DIRS, WALL_THICKNESS, cellCenter, hasWall } from "./grid.js";

// World-space transforms for everything placed on the map. Shared by rendering,
// collision and interaction so they can never disagree about where a thing is.
// yaw: rotation around Y so that the object's local +Z points along `normal`.

export const PROP_SIZE = {
  chair: { hw: 0.26, hd: 0.26, collide: true },
  desk: { hw: 0.75, hd: 0.38, collide: true },
  boxes: { hw: 0.45, hd: 0.45, collide: true },
};

function hash01(i, salt) {
  let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

export function wallFrame(g, x, y, dir, inset = 0) {
  const c = cellCenter(g, x, y);
  const out = DIRS[dir];
  const dist = CELL / 2 - WALL_THICKNESS / 2 - inset;
  const normal = { x: -out.dx, z: -out.dy };
  return {
    x: c.x + out.dx * dist,
    z: c.z + out.dy * dist,
    normal,
    tangent: { x: -normal.z, z: normal.x },
    yaw: Math.atan2(normal.x, normal.z),
  };
}

export function propTransform(g, p) {
  const c = cellCenter(g, p.x, p.y);
  switch (p.type) {
    case "desk":
    case "boxes": {
      const size = PROP_SIZE[p.type];
      const f = wallFrame(g, p.x, p.y, p.dir, size.hd + 0.04);
      const slide = p.type === "boxes" ? Math.sign(p.u || 1) * 0.85 : p.u * 0.5;
      return { x: f.x + f.tangent.x * slide, z: f.z + f.tangent.z * slide, yaw: f.yaw };
    }
    case "chair": {
      const out = DIRS[p.dir];
      if (hasWall(g, p.x, p.y, p.dir)) {
        return { x: c.x + out.dx * 0.85 - out.dy * p.u * 0.6, z: c.z + out.dy * 0.85 + out.dx * p.u * 0.6, yaw: p.rot };
      }
      // No wall to lean on: tuck into a corner so it never sits on a walking line.
      const sx = hash01(p.index, 11) < 0.5 ? -1 : 1;
      const sz = hash01(p.index, 13) < 0.5 ? -1 : 1;
      return { x: c.x + sx * 0.85, z: c.z + sz * 0.85, yaw: p.rot };
    }
    case "wallStain":
    case "vent":
    case "fakeDoor":
    case "scribble": {
      const f = wallFrame(g, p.x, p.y, p.dir, -0.005);
      const slide = p.type === "fakeDoor" ? 0 : p.u;
      return { x: f.x + f.tangent.x * slide, z: f.z + f.tangent.z * slide, yaw: f.yaw };
    }
    default:
      // floor decals, wet sign, fallen tile
      return { x: c.x + p.u, z: c.z + (hash01(p.index, 7) - 0.5) * 1.2, yaw: p.rot };
  }
}

export function propCollider(g, p) {
  const size = PROP_SIZE[p.type];
  if (!size?.collide) return null;
  const t = propTransform(g, p);
  // Axis-aligned bounds of the rotated footprint.
  const c = Math.abs(Math.cos(t.yaw));
  const s = Math.abs(Math.sin(t.yaw));
  const ex = size.hw * c + size.hd * s;
  const ez = size.hw * s + size.hd * c;
  return { minX: t.x - ex, maxX: t.x + ex, minZ: t.z - ez, maxZ: t.z + ez };
}

export function objectiveTransforms(map) {
  const g = map.grid;
  const { power, tape, exit } = map.objectives;
  const px = (i) => i % g.w;
  const py = (i) => (i / g.w) | 0;

  const panel = wallFrame(g, px(power.index), py(power.index), power.dir, 0.08);
  const tv = wallFrame(g, px(tape.index), py(tape.index), tape.dir, 0.35);
  const tapePos = {
    x: tv.x + tv.normal.x * 0.75 + tv.tangent.x * 0.25,
    z: tv.z + tv.normal.z * 0.75 + tv.tangent.z * 0.25,
    yaw: tv.yaw + 0.4,
  };
  const door = wallFrame(g, px(exit.index), py(exit.index), exit.dir, -WALL_THICKNESS / 2);
  return { panel, tv, tape: tapePos, door };
}

export function batteryTransform(map, index) {
  const g = map.grid;
  const x = index % g.w;
  const y = (index / g.w) | 0;
  const c = cellCenter(g, x, y);
  for (let d = 0; d < 4; d++) {
    const dir = (d + Math.floor(hash01(index, 3) * 4)) % 4;
    if (hasWall(g, x, y, dir)) {
      const f = wallFrame(g, x, y, dir, 0.3);
      return { x: f.x + f.tangent.x * (hash01(index, 5) - 0.5), z: f.z + f.tangent.z * (hash01(index, 5) - 0.5), yaw: f.yaw };
    }
  }
  return { x: c.x + 0.6, z: c.z + 0.6, yaw: 0 };
}
