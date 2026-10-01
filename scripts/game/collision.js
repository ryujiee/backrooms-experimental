import { CELL, WALL_THICKNESS, PILLAR_SIZE, WALL_HEIGHT, cornerWorld } from "./grid.js";
import { propCollider } from "./placement.js";

// Circle-vs-AABB collision over a per-cell spatial hash, plus a fine occupancy
// raster for line-of-sight. Movement is split into sub-steps no longer than half
// the radius, so no speed or frame hitch can tunnel through a 0.2 m wall.

const OCC_RES = 0.2;
const BUCKET_MARGIN = 0.6;

export function createCollision(map, extraBoxes = []) {
  const g = map.grid;
  const T = WALL_THICKNESS;
  const boxes = [];
  const add = (minX, minZ, maxX, maxZ, opts = {}) => {
    boxes.push({ minX, minZ, maxX, maxZ, enabled: true, sight: opts.sight !== false, tag: opts.tag || "wall" });
    return boxes.length - 1;
  };
  const openSide = (x, y) => x >= 0 && y >= 0 && x < g.w && y < g.h && !g.solid[y * g.w + x];

  for (let y = 0; y <= g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      if (!g.hWall[y * g.w + x] || (!openSide(x, y - 1) && !openSide(x, y))) continue;
      const c = cornerWorld(g, x, y);
      add(c.x - T / 2, c.z - T / 2, c.x + CELL + T / 2, c.z + T / 2);
    }
  }
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x <= g.w; x++) {
      if (!g.vWall[y * (g.w + 1) + x] || (!openSide(x - 1, y) && !openSide(x, y))) continue;
      const c = cornerWorld(g, x, y);
      add(c.x - T / 2, c.z - T / 2, c.x + T / 2, c.z + CELL + T / 2);
    }
  }
  for (let j = 0; j <= g.h; j++) {
    for (let i = 0; i <= g.w; i++) {
      if (!g.pillar[j * (g.w + 1) + i]) continue;
      const c = cornerWorld(g, i, j);
      const s = PILLAR_SIZE / 2;
      add(c.x - s, c.z - s, c.x + s, c.z + s, { tag: "pillar" });
    }
  }
  for (let i = 0; i < g.w * g.h; i++) {
    if (!g.solid[i]) continue;
    const c = cornerWorld(g, i % g.w, (i / g.w) | 0);
    add(c.x, c.z, c.x + CELL, c.z + CELL, { tag: "solid" });
  }
  const propBoxes = [];
  for (const p of map.props) {
    const b = propCollider(g, p);
    if (b) propBoxes.push({ prop: p, box: add(b.minX, b.minZ, b.maxX, b.maxZ, { sight: false, tag: "prop" }) });
  }
  const extraIds = extraBoxes.map((b) => add(b.minX, b.minZ, b.maxX, b.maxZ, b));

  // Spatial hash: one bucket per cell, with an outer ring for things outside the grid (exit chamber).
  const bw = g.w + 2;
  const bh = g.h + 2;
  const buckets = Array.from({ length: bw * bh }, () => []);
  const bucketX = (wx) => Math.min(bw - 1, Math.max(0, Math.floor(wx / CELL + g.w / 2) + 1));
  const bucketY = (wz) => Math.min(bh - 1, Math.max(0, Math.floor(wz / CELL + g.h / 2) + 1));
  const bucketOf = (wx, wz) => bucketY(wz) * bw + bucketX(wx);
  const registered = boxes.map(() => []);
  const register = (id) => {
    const b = boxes[id];
    for (let by = bucketY(b.minZ - BUCKET_MARGIN); by <= bucketY(b.maxZ + BUCKET_MARGIN); by++) {
      for (let bx = bucketX(b.minX - BUCKET_MARGIN); bx <= bucketX(b.maxX + BUCKET_MARGIN); bx++) {
        buckets[by * bw + bx].push(id);
        registered[id].push(by * bw + bx);
      }
    }
  };
  const unregister = (id) => {
    for (const k of registered[id]) {
      const list = buckets[k];
      list.splice(list.indexOf(id), 1);
    }
    registered[id] = [];
  };
  boxes.forEach((_, id) => register(id));

  // Occupancy raster covering the grid plus a one-cell ring.
  const originX = -(g.w / 2 + 1) * CELL;
  const originZ = -(g.h / 2 + 1) * CELL;
  const occW = Math.ceil(((g.w + 2) * CELL) / OCC_RES);
  const occH = Math.ceil(((g.h + 2) * CELL) / OCC_RES);
  const occ = new Uint8Array(occW * occH);
  const rasterize = (b, delta) => {
    if (!b.sight) return;
    const x0 = Math.max(0, Math.floor((b.minX - originX) / OCC_RES));
    const x1 = Math.min(occW - 1, Math.floor((b.maxX - originX) / OCC_RES));
    const z0 = Math.max(0, Math.floor((b.minZ - originZ) / OCC_RES));
    const z1 = Math.min(occH - 1, Math.floor((b.maxZ - originZ) / OCC_RES));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) occ[z * occW + x] += delta;
  };
  boxes.forEach((b) => rasterize(b, 1));

  function resolve(pos, r) {
    const list = buckets[bucketOf(pos.x, pos.z)];
    let hit = false;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (let k = 0; k < list.length; k++) {
        const b = boxes[list[k]];
        if (!b.enabled) continue;
        const cx = pos.x < b.minX ? b.minX : pos.x > b.maxX ? b.maxX : pos.x;
        const cz = pos.z < b.minZ ? b.minZ : pos.z > b.maxZ ? b.maxZ : pos.z;
        const dx = pos.x - cx;
        const dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          pos.x += (dx / d) * (r - d);
          pos.z += (dz / d) * (r - d);
        } else {
          // Centre inside the box: leave through the nearest face.
          const left = pos.x - b.minX + r;
          const right = b.maxX - pos.x + r;
          const top = pos.z - b.minZ + r;
          const bottom = b.maxZ - pos.z + r;
          const m = Math.min(left, right, top, bottom);
          if (m === left) pos.x -= left;
          else if (m === right) pos.x += right;
          else if (m === top) pos.z -= top;
          else pos.z += bottom;
        }
        moved = true;
        hit = true;
      }
      if (!moved) break;
    }
    return hit;
  }

  // Moves pos ({x, z}, mutated) by (dx, dz). Returns true when anything was hit.
  function moveCircle(pos, dx, dz, r) {
    const len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(len / (r * 0.5)));
    let hit = false;
    for (let s = 0; s < steps; s++) {
      pos.x += dx / steps;
      pos.z += dz / steps;
      if (resolve(pos, r)) hit = true;
    }
    return hit;
  }

  function overlapsCircle(x, z, r) {
    const list = buckets[bucketOf(x, z)];
    for (let k = 0; k < list.length; k++) {
      const b = boxes[list[k]];
      if (!b.enabled) continue;
      const cx = Math.max(b.minX, Math.min(x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
      if ((x - cx) ** 2 + (z - cz) ** 2 < r * r) return true;
    }
    return false;
  }

  // Amanatides-Woo traversal of the occupancy raster. True when nothing blocks the segment.
  function segmentClear(ax, az, bx, bz) {
    let x = Math.floor((ax - originX) / OCC_RES);
    let z = Math.floor((az - originZ) / OCC_RES);
    const tx = Math.floor((bx - originX) / OCC_RES);
    const tz = Math.floor((bz - originZ) / OCC_RES);
    const dx = bx - ax;
    const dz = bz - az;
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const invX = dx !== 0 ? Math.abs(OCC_RES / dx) : Infinity;
    const invZ = dz !== 0 ? Math.abs(OCC_RES / dz) : Infinity;
    const fx = (ax - originX) / OCC_RES - x;
    const fz = (az - originZ) / OCC_RES - z;
    let tMaxX = dx > 0 ? (1 - fx) * invX : fx * invX;
    let tMaxZ = dz > 0 ? (1 - fz) * invZ : fz * invZ;
    const maxSteps = Math.abs(tx - x) + Math.abs(tz - z) + 2;
    for (let i = 0; i < maxSteps; i++) {
      if (x < 0 || z < 0 || x >= occW || z >= occH) return false;
      if (occ[z * occW + x]) return false;
      if (x === tx && z === tz) return true;
      if (tMaxX < tMaxZ) {
        tMaxX += invX;
        x += stepX;
      } else {
        tMaxZ += invZ;
        z += stepZ;
      }
    }
    return true;
  }

  // Wide clearance check for an agent of radius r (centre line plus both edges).
  function corridorClear(ax, az, bx, bz, r) {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    const ox = (-dz / len) * r;
    const oz = (dx / len) * r;
    return (
      segmentClear(ax, az, bx, bz) &&
      segmentClear(ax + ox, az + oz, bx + ox, bz + oz) &&
      segmentClear(ax - ox, az - oz, bx - ox, bz - oz)
    );
  }

  function setEnabled(id, enabled) {
    const b = boxes[id];
    if (b.enabled === enabled) return;
    b.enabled = enabled;
    rasterize(b, enabled ? 1 : -1);
  }

  // Replaces a box's bounds (used when a prop is moved by an event).
  function moveBox(id, minX, minZ, maxX, maxZ) {
    const b = boxes[id];
    if (b.enabled) rasterize(b, -1);
    unregister(id);
    Object.assign(b, { minX, minZ, maxX, maxZ });
    register(id);
    if (b.enabled) rasterize(b, 1);
  }

  return {
    boxes,
    propBoxes,
    extraIds,
    moveCircle,
    overlapsCircle,
    segmentClear,
    corridorClear,
    setEnabled,
    moveBox,
    wallHeight: WALL_HEIGHT,
  };
}
