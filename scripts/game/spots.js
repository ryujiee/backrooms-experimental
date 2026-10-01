import { DIRS, canMove, cellCenter, hasWall, isBorderEdge, worldToCell } from "./grid.js";
import { bfsDistances } from "./pathfinding.js";

// Spatial queries for the director. Teleport rule (fairness): the creature may only
// be placed where the player cannot currently see it -> no line of sight, or far
// away behind the player -> and never closer than MIN_TELEPORT_DIST.

export const MIN_TELEPORT_DIST = 14;

export function forwardOf(yaw) {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

export function inViewCone(player, x, z, cosLimit = 0.45) {
  const f = forwardOf(player.yaw);
  const dx = x - player.x;
  const dz = z - player.z;
  const d = Math.hypot(dx, dz) || 1;
  return (dx * f.x + dz * f.z) / d > cosLimit;
}

export function canPlayerSee(collision, player, x, z, cosLimit = 0.45) {
  return inViewCone(player, x, z, cosLimit) && collision.segmentClear(player.x, player.z, x, z);
}

export function isSafeTeleport(collision, player, x, z, minDist = MIN_TELEPORT_DIST) {
  const d = Math.hypot(x - player.x, z - player.z);
  if (d < minDist) return false;
  if (!collision.segmentClear(player.x, player.z, x, z)) return true;
  // Visible line but behind the player and far: they cannot be looking at it.
  return !inViewCone(player, x, z, -0.35) && d > 20;
}

function playerCellIndex(map, player) {
  const c = worldToCell(map.grid, player.x, player.z);
  return c.y * map.grid.w + c.x;
}

// A far cell the creature can be moved to without the player noticing.
export function findFarRelocation(map, collision, player, rng, minCells = 14) {
  const g = map.grid;
  const dist = bfsDistances(g, playerCellIndex(map, player));
  const options = [];
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] >= minCells && dist[i] <= minCells + 16) options.push(i);
  }
  rng.shuffle(options);
  for (const i of options.slice(0, 40)) {
    const c = cellCenter(g, i % g.w, (i / g.w) | 0);
    if (isSafeTeleport(collision, player, c.x, c.z, minCells * 2)) return c;
  }
  return null;
}

// End of a straight sightline from the player, currently outside their view, so the
// creature is "already there" when they turn around.
export function findStalkSpot(map, collision, player, rng) {
  const g = map.grid;
  const pc = worldToCell(g, player.x, player.z);
  const candidates = [];
  for (let d = 0; d < 4; d++) {
    let x = pc.x;
    let y = pc.y;
    for (let s = 1; s <= 10; s++) {
      if (!canMove(g, x, y, d)) break;
      x += DIRS[d].dx;
      y += DIRS[d].dy;
      if (s < 5) continue;
      const c = cellCenter(g, x, y);
      const dist = Math.hypot(c.x - player.x, c.z - player.z);
      if (dist < MIN_TELEPORT_DIST || dist > 30) continue;
      if (inViewCone(player, c.x, c.z, 0.2)) continue;
      if (!collision.segmentClear(player.x, player.z, c.x, c.z)) continue;
      candidates.push(c);
    }
  }
  return candidates.length ? rng.pick(candidates) : null;
}

// A corridor junction ahead of the player that the creature can walk across.
export function findCrossing(map, collision, player, rng) {
  const g = map.grid;
  const pc = worldToCell(g, player.x, player.z);
  const f = forwardOf(player.yaw);
  const d = Math.abs(f.x) > Math.abs(f.z) ? (f.x > 0 ? 1 : 3) : f.z > 0 ? 2 : 0;
  let x = pc.x;
  let y = pc.y;
  const options = [];
  for (let s = 1; s <= 9; s++) {
    if (!canMove(g, x, y, d)) break;
    x += DIRS[d].dx;
    y += DIRS[d].dy;
    if (s < 4) continue;
    const a = (d + 1) % 4;
    const b = (d + 3) % 4;
    if (!canMove(g, x, y, a) || !canMove(g, x, y, b)) continue;
    const from = cellCenter(g, x + DIRS[a].dx, y + DIRS[a].dy);
    const to = cellCenter(g, x + DIRS[b].dx, y + DIRS[b].dy);
    const center = cellCenter(g, x, y);
    if (Math.hypot(center.x - player.x, center.z - player.z) < 11) continue;
    if (collision.segmentClear(player.x, player.z, from.x, from.z)) continue;
    options.push({ from, to });
  }
  return options.length ? rng.pick(options) : null;
}

// Lamp currently lit, behind the player, not too far: switching it off is felt, not seen.
export function findLampBehind(map, player, isLit, rng) {
  const g = map.grid;
  const options = [];
  map.lamps.forEach((lamp, i) => {
    if (!isLit(i)) return;
    const c = cellCenter(g, lamp.x, lamp.y);
    const d = Math.hypot(c.x - player.x, c.z - player.z);
    if (d < 5 || d > 16) return;
    if (inViewCone(player, c.x, c.z, -0.2)) return;
    options.push(i);
  });
  return options.length ? rng.pick(options) : -1;
}

// Hidden point near the player (behind a wall) for knocks and phantom sounds.
export function findHiddenPoint(map, collision, player, rng, minD = 5, maxD = 12) {
  const g = map.grid;
  for (let t = 0; t < 30; t++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(minD, maxD);
    const x = player.x + Math.cos(a) * r;
    const z = player.z + Math.sin(a) * r;
    const c = worldToCell(g, x, z);
    if (g.solid[c.y * g.w + c.x] && t < 25) continue;
    if (!collision.segmentClear(player.x, player.z, x, z)) return { x, z };
  }
  return null;
}

// Interior wall slot out of view, for "a door that was not there before".
export function findNewDoorSlot(map, collision, player, rng, used) {
  const g = map.grid;
  const pc = worldToCell(g, player.x, player.z);
  for (let t = 0; t < 60; t++) {
    const x = pc.x + rng.int(-4, 4);
    const y = pc.y + rng.int(-4, 4);
    if (x < 0 || y < 0 || x >= g.w || y >= g.h || g.solid[y * g.w + x]) continue;
    const dir = rng.int(0, 3);
    if (!hasWall(g, x, y, dir) || isBorderEdge(g, x, y, dir) || used.has(`${y * g.w + x}:${dir}`)) continue;
    const c = cellCenter(g, x, y);
    const d = Math.hypot(c.x - player.x, c.z - player.z);
    if (d < 6 || d > 15 || canPlayerSee(collision, player, c.x, c.z, 0.1)) continue;
    if (collision.segmentClear(player.x, player.z, c.x, c.z)) continue;
    return { index: y * g.w + x, x, y, dir };
  }
  return null;
}
