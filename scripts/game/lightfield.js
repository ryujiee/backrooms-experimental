import { CELL, cellCenter } from "./grid.js";

// 2D irradiance field of the ceiling lamps, baked with wall occlusion.
// The world shader samples it by world XZ, so hundreds of lamps cost one texture
// fetch instead of hundreds of PointLights. Lamps can be switched at runtime by
// adding/subtracting their cached splat (no re-raycast).

export const LIGHT_TEXEL = 0.5;
export const LIGHT_MAX = 2.5;
const RADIUS = 6.5;

export const LAMP_COLORS = {
  normal: [1.0, 0.95, 0.8],
  flicker: [1.0, 0.95, 0.8],
  off: [1.0, 0.95, 0.8],
  red: [1.0, 0.16, 0.1],
};

export function createLightField(map, collision) {
  const g = map.grid;
  const sizeX = Math.ceil((g.w * CELL) / LIGHT_TEXEL);
  const sizeZ = Math.ceil((g.h * CELL) / LIGHT_TEXEL);
  const originX = (-g.w * CELL) / 2;
  const originZ = (-g.h * CELL) / 2;
  const accum = new Float32Array(sizeX * sizeZ * 3);
  const levels = new Float32Array(map.lamps.length);
  const splats = new Array(map.lamps.length);
  const bytes = new Uint8Array(sizeX * sizeZ * 4);
  let dirty = true;

  function computeSplat(li) {
    const lamp = map.lamps[li];
    const c = cellCenter(g, lamp.x, lamp.y);
    const r = Math.ceil(RADIUS / LIGHT_TEXEL);
    const cx = Math.floor((c.x - originX) / LIGHT_TEXEL);
    const cz = Math.floor((c.z - originZ) / LIGHT_TEXEL);
    const idx = [];
    const wts = [];
    for (let z = Math.max(0, cz - r); z <= Math.min(sizeZ - 1, cz + r); z++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(sizeX - 1, cx + r); x++) {
        const tx = originX + (x + 0.5) * LIGHT_TEXEL;
        const tz = originZ + (z + 0.5) * LIGHT_TEXEL;
        const d2 = (tx - c.x) ** 2 + (tz - c.z) ** 2;
        if (d2 >= RADIUS * RADIUS) continue;
        if (!collision.segmentClear(c.x, c.z, tx, tz)) continue;
        const win = 1 - d2 / (RADIUS * RADIUS);
        idx.push(z * sizeX + x);
        wts.push(win * win * (0.55 + 0.45 * Math.exp(-d2 / 4)));
      }
    }
    return { idx: Uint32Array.from(idx), w: Float32Array.from(wts) };
  }

  function setLampLevel(li, level) {
    const delta = level - levels[li];
    if (Math.abs(delta) < 1e-4) return;
    levels[li] = level;
    if (!splats[li]) splats[li] = computeSplat(li);
    const s = splats[li];
    const col = LAMP_COLORS[map.lamps[li].kind] || LAMP_COLORS.normal;
    for (let k = 0; k < s.idx.length; k++) {
      const o = s.idx[k] * 3;
      const v = s.w[k] * delta;
      accum[o] += v * col[0];
      accum[o + 1] += v * col[1];
      accum[o + 2] += v * col[2];
    }
    dirty = true;
  }

  // Luminance at a world point (used by the creature to judge how visible the player is).
  function sample(wx, wz) {
    const x = Math.floor((wx - originX) / LIGHT_TEXEL);
    const z = Math.floor((wz - originZ) / LIGHT_TEXEL);
    if (x < 0 || z < 0 || x >= sizeX || z >= sizeZ) return 0;
    const o = (z * sizeX + x) * 3;
    return accum[o] * 0.3 + accum[o + 1] * 0.59 + accum[o + 2] * 0.11;
  }

  // sqrt encoding keeps precision in the dark end where it matters.
  function encode() {
    for (let i = 0, o = 0; i < accum.length; i += 3, o += 4) {
      bytes[o] = Math.sqrt(Math.max(0, Math.min(1, accum[i] / LIGHT_MAX))) * 255;
      bytes[o + 1] = Math.sqrt(Math.max(0, Math.min(1, accum[i + 1] / LIGHT_MAX))) * 255;
      bytes[o + 2] = Math.sqrt(Math.max(0, Math.min(1, accum[i + 2] / LIGHT_MAX))) * 255;
      bytes[o + 3] = 255;
    }
    dirty = false;
    return bytes;
  }

  return {
    sizeX,
    sizeZ,
    originX,
    originZ,
    bytes,
    levels,
    setLampLevel,
    getLampLevel: (li) => levels[li],
    sample,
    encode,
    isDirty: () => dirty,
  };
}
