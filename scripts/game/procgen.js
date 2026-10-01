import { createRng } from "../core/rng.js";
import {
  DIRS,
  createGrid,
  inBounds,
  hasWall,
  setWall,
  canMove,
  openCount,
  isBorderEdge,
} from "./grid.js";
import { bfsDistances, cellsAligned } from "./pathfinding.js";

// Procedural Backrooms layout.
// Pipeline: zones -> spanning maze -> rooms / pillar halls -> long corridors -> solid blocks
// -> braiding (loops) -> connectivity repair -> placements -> validation.
// A failed validation retries with a derived seed; the last attempts relax distances.

export const ZONE = { OFFICE: 0, HALL: 1, CORRIDOR: 2, DARK: 3, DAMP: 4, RED: 5 };
export const ZONE_NAMES = ["escritório", "salão", "corredores", "apagão", "umidade", "vermelho"];

const MAX_ATTEMPTS = 12;
const STRAIGHTNESS = [0.45, 0.5, 0.82, 0.5, 0.4, 0.4];
const ZONE_WEIGHTS = [
  { type: ZONE.OFFICE, weight: 0.36 },
  { type: ZONE.HALL, weight: 0.18 },
  { type: ZONE.CORRIDOR, weight: 0.22 },
  { type: ZONE.DARK, weight: 0.13 },
  { type: ZONE.DAMP, weight: 0.11 },
];
// Lamp kind odds per zone: [normal, flicker] (rest = off).
const LAMP_ODDS = [
  [0.88, 0.07],
  [0.84, 0.08],
  [0.9, 0.06],
  [0.12, 0.13],
  [0.68, 0.16],
  [1, 0],
];

export const PROP_TYPES = [
  "chair",
  "desk",
  "boxes",
  "wetSign",
  "fallenTile",
  "floorStain",
  "wallStain",
  "vent",
  "fakeDoor",
  "scribble",
];

export function generateMap(seedLabel, options = {}) {
  const opts = { width: 34, height: 34, ...options };
  let lastErrors = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const rng = createRng(`${seedLabel}#${attempt}`);
    const relaxed = attempt >= MAX_ATTEMPTS - 3;
    const map = buildMap(rng, opts, relaxed);
    const errors = map ? validateMap(map) : ["placement failed"];
    if (!errors.length) {
      map.seed = String(seedLabel);
      map.attempts = attempt + 1;
      return map;
    }
    lastErrors = errors;
  }
  throw new Error(`Map generation failed for seed "${seedLabel}": ${lastErrors.join("; ")}`);
}

function buildMap(rng, opts, relaxed) {
  const g = createGrid(opts.width, opts.height);
  const { w, h } = g;
  const n = w * h;

  const spawn = {
    x: Math.floor(w / 2) + rng.int(-3, 3),
    y: Math.floor(h / 2) + rng.int(-3, 3),
  };
  const spawnIndex = spawn.y * w + spawn.x;

  assignZones(g, rng, spawn);
  carveMaze(g, rng, spawnIndex);
  carveRooms(g, rng);
  const halls = carveHalls(g, rng, spawn);
  carveLongCorridors(g, rng, spawn);
  placeSolidBlocks(g, rng, spawn);
  braid(g, rng, 0.72);
  openRandomWalls(g, rng, Math.round(n * 0.025));
  repairConnectivity(g, rng, spawnIndex);

  const dist = bfsDistances(g, spawnIndex);
  let maxDist = 0;
  for (let i = 0; i < n; i++) if (dist[i] > maxDist) maxDist = dist[i];

  const reserved = new Set([spawnIndex]);
  const cellsBy = (pred) => {
    const out = [];
    for (let i = 0; i < n; i++) if (!g.solid[i] && dist[i] >= 0 && !reserved.has(i) && pred(i)) out.push(i);
    return out;
  };
  const wallDirs = (i, allowBorder = true) => {
    const x = i % w;
    const y = (i / w) | 0;
    const out = [];
    for (let d = 0; d < 4; d++) {
      if (!hasWall(g, x, y, d)) continue;
      if (!allowBorder && isBorderEdge(g, x, y, d)) continue;
      const nx = x + DIRS[d].dx;
      const ny = y + DIRS[d].dy;
      // Walls facing a solid block are fine; walls facing an open cell must be real walls.
      if (inBounds(g, nx, ny) || allowBorder) out.push(d);
    }
    return out;
  };

  const k = relaxed ? 0.7 : 1;

  // Objective 1: electrical panel, mid distance, mounted on a wall.
  const powerCandidates = cellsBy(
    (i) =>
      dist[i] >= maxDist * 0.35 * k &&
      dist[i] <= maxDist * (relaxed ? 0.8 : 0.62) &&
      g.zone[i] !== ZONE.RED &&
      wallDirs(i).length > 0
  );
  if (!powerCandidates.length) return null;
  const powerIndex = rng.pick(powerCandidates);
  const power = { index: powerIndex, dir: rng.pick(wallDirs(powerIndex)) };
  reserved.add(powerIndex);
  const distPower = bfsDistances(g, powerIndex);

  // Objective 2: VHS tape next to a TV, away from the panel.
  const tapeCandidates = cellsBy(
    (i) =>
      dist[i] >= maxDist * 0.42 * k &&
      distPower[i] >= maxDist * 0.4 * k &&
      g.zone[i] !== ZONE.RED &&
      wallDirs(i).length > 0
  );
  if (!tapeCandidates.length) return null;
  const tapeIndex = rng.pick(tapeCandidates);
  const tape = { index: tapeIndex, dir: rng.pick(wallDirs(tapeIndex)) };
  reserved.add(tapeIndex);
  const distTape = bfsDistances(g, tapeIndex);

  // Objective 3: exit door set into the outer wall, far from everything.
  const exitCandidates = [];
  for (const i of cellsBy((i) => dist[i] >= maxDist * 0.7 * k)) {
    const x = i % w;
    const y = (i / w) | 0;
    if (distTape[i] < maxDist * 0.3 * k || distPower[i] < maxDist * 0.3 * k) continue;
    for (let d = 0; d < 4; d++) {
      if (isBorderEdge(g, x, y, d)) exitCandidates.push({ index: i, dir: d, score: dist[i] + rng.next() * 6 });
    }
  }
  if (!exitCandidates.length) return null;
  exitCandidates.sort((a, b) => b.score - a.score);
  const exit = exitCandidates[Math.min(exitCandidates.length - 1, rng.int(0, 4))];
  reserved.add(exit.index);
  const distExit = bfsDistances(g, exit.index);

  // Creature spawn: far from the player, not in a straight sightline, not camping the exit.
  const monsterCandidates = cellsBy(
    (i) =>
      dist[i] >= maxDist * 0.55 * k &&
      distExit[i] >= 6 &&
      distTape[i] >= 4 &&
      distPower[i] >= 4 &&
      !cellsAligned(g, spawnIndex, i)
  );
  if (!monsterCandidates.length) return null;
  const monsterSpawn = rng.pick(monsterCandidates);
  reserved.add(monsterSpawn);

  // Rare red room, a landmark mid-way through the map.
  const redCandidates = cellsBy((i) => dist[i] >= maxDist * 0.25 && dist[i] <= maxDist * 0.75);
  if (redCandidates.length) {
    const c = rng.pick(redCandidates);
    const cx = c % w;
    const cy = (c / w) | 0;
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (inBounds(g, x, y) && !g.solid[y * w + x]) g.zone[y * w + x] = ZONE.RED;
      }
    }
  }

  // Flashlight batteries: spread out, favouring dead ends and corners (reward exploring).
  const batteries = [];
  const batteryTarget = relaxed ? 6 : 9;
  const batteryCandidates = rng
    .shuffle(cellsBy((i) => dist[i] >= 4))
    .sort((a, b) => openCount(g, a % w, (a / w) | 0) - openCount(g, b % w, (b / w) | 0));
  const farEnough = (i) =>
    batteries.every((b) => Math.abs((b % w) - (i % w)) + Math.abs(((b / w) | 0) - ((i / w) | 0)) >= 5);
  // Two early batteries first so a flashlight-heavy start is never punished.
  for (const i of batteryCandidates) {
    if (batteries.length >= 2) break;
    if (dist[i] < maxDist * 0.35 && farEnough(i)) batteries.push(i);
  }
  for (const i of batteryCandidates) {
    if (batteries.length >= batteryTarget) break;
    if (!batteries.includes(i) && farEnough(i)) batteries.push(i);
  }
  batteries.forEach((i) => reserved.add(i));

  const lamps = placeLamps(g, rng);
  const props = placeProps(g, rng, reserved, exit, power, tape);

  return {
    grid: g,
    width: w,
    height: h,
    spawn: { index: spawnIndex, yaw: pickSpawnYaw(g, spawn, rng) },
    objectives: { power, tape, exit },
    monsterSpawn,
    batteries,
    lamps,
    props,
    halls,
    distFromSpawn: dist,
    maxDist,
    relaxed,
  };
}

function assignZones(g, rng, spawn) {
  const seeds = [];
  const count = Math.max(6, Math.round((g.w * g.h) / 85));
  for (let i = 0; i < count; i++) {
    seeds.push({ x: rng.range(0, g.w), y: rng.range(0, g.h), type: rng.weighted(ZONE_WEIGHTS).type });
  }
  // Guarantee variety: at least one hall, corridor, dark and damp area.
  const forced = [ZONE.HALL, ZONE.CORRIDOR, ZONE.DARK, ZONE.DAMP];
  forced.forEach((type, i) => (seeds[i + 1].type = type));
  // The player always wakes up somewhere readable.
  seeds[0] = { x: spawn.x + 0.5, y: spawn.y + 0.5, type: ZONE.OFFICE };

  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      let best = 0;
      let bestD = Infinity;
      for (let s = 0; s < seeds.length; s++) {
        const dx = seeds[s].x - (x + 0.5);
        const dy = seeds[s].y - (y + 0.5);
        const d = dx * dx + dy * dy + rng.next() * 3;
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      g.zone[y * g.w + x] = seeds[best].type;
    }
  }
  // Keep the wake-up area lit.
  for (let y = spawn.y - 2; y <= spawn.y + 2; y++) {
    for (let x = spawn.x - 2; x <= spawn.x + 2; x++) {
      if (inBounds(g, x, y)) g.zone[y * g.w + x] = ZONE.OFFICE;
    }
  }
}

function carveMaze(g, rng, startIndex) {
  const visited = new Uint8Array(g.w * g.h);
  const lastDir = new Int8Array(g.w * g.h).fill(-1);
  const stack = [startIndex];
  visited[startIndex] = 1;
  const options = [];
  while (stack.length) {
    const cur = stack[stack.length - 1];
    const x = cur % g.w;
    const y = (cur / g.w) | 0;
    options.length = 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d].dx;
      const ny = y + DIRS[d].dy;
      if (inBounds(g, nx, ny) && !visited[ny * g.w + nx]) options.push(d);
    }
    if (!options.length) {
      stack.pop();
      continue;
    }
    const prev = lastDir[cur];
    const d =
      prev >= 0 && options.includes(prev) && rng.chance(STRAIGHTNESS[g.zone[cur]]) ? prev : rng.pick(options);
    setWall(g, x, y, d, 0);
    const ni = (y + DIRS[d].dy) * g.w + x + DIRS[d].dx;
    visited[ni] = 1;
    lastDir[ni] = d;
    stack.push(ni);
  }
}

function carveRect(g, x0, y0, rw, rh) {
  for (let y = y0; y < y0 + rh; y++) {
    for (let x = x0; x < x0 + rw; x++) {
      if (x + 1 < x0 + rw) setWall(g, x, y, 1, 0);
      if (y + 1 < y0 + rh) setWall(g, x, y, 2, 0);
    }
  }
}

function clampRect(g, x0, y0, rw, rh) {
  const x = Math.max(0, Math.min(g.w - rw, x0));
  const y = Math.max(0, Math.min(g.h - rh, y0));
  return { x, y, rw: Math.min(rw, g.w), rh: Math.min(rh, g.h) };
}

function carveRooms(g, rng) {
  const tries = Math.round((g.w * g.h) / 22);
  for (let t = 0; t < tries; t++) {
    const i = rng.int(0, g.w * g.h - 1);
    const zone = g.zone[i];
    if (zone === ZONE.CORRIDOR || zone === ZONE.HALL) continue;
    const r = clampRect(g, i % g.w, (i / g.w) | 0, rng.int(2, 4), rng.int(2, 3));
    carveRect(g, r.x, r.y, r.rw, r.rh);
  }
}

function carveHalls(g, rng, spawn) {
  const halls = [];
  const taken = new Uint8Array(g.w * g.h);
  for (let i = 0; i < g.w * g.h; i++) {
    if (g.zone[i] !== ZONE.HALL || taken[i]) continue;
    if (!rng.chance(0.08)) continue;
    const rw = rng.int(5, 8);
    const rh = rng.int(4, 7);
    const r = clampRect(g, (i % g.w) - (rw >> 1), ((i / g.w) | 0) - (rh >> 1), rw, rh);
    let overlap = false;
    for (let y = r.y; y < r.y + r.rh && !overlap; y++) {
      for (let x = r.x; x < r.x + r.rw; x++) if (taken[y * g.w + x]) overlap = true;
    }
    if (overlap) continue;
    for (let y = r.y; y < r.y + r.rh; y++) for (let x = r.x; x < r.x + r.rw; x++) taken[y * g.w + x] = 1;
    carveRect(g, r.x, r.y, r.rw, r.rh);

    // Pillar lattice on interior corners ("spaces with many columns").
    const stride = rng.pick([1, 2, 2]);
    for (let j = r.y + 1; j < r.y + r.rh; j++) {
      for (let c = r.x + 1; c < r.x + r.rw; c++) {
        if ((c - r.x) % stride || (j - r.y) % stride) continue;
        const nearSpawn = Math.abs(c - spawn.x) < 2 && Math.abs(j - spawn.y) < 2;
        if (!nearSpawn) g.pillar[j * (g.w + 1) + c] = 1;
      }
    }
    // A couple of free-standing partition walls break long sightlines.
    const fragments = rng.int(1, 3);
    for (let f = 0; f < fragments; f++) {
      const x = rng.int(r.x, r.x + r.rw - 2);
      const y = rng.int(r.y, r.y + r.rh - 2);
      const horizontal = rng.chance(0.5);
      const len = rng.int(1, 2);
      for (let s = 0; s < len; s++) {
        if (horizontal && x + s < r.x + r.rw) setWall(g, x + s, y, 2, 1);
        if (!horizontal && y + s < r.y + r.rh) setWall(g, x, y + s, 1, 1);
      }
    }
    halls.push(r);
  }
  return halls;
}

function carveLongCorridors(g, rng, spawn) {
  const count = rng.int(3, 5);
  for (let c = 0; c < count; c++) {
    let start = null;
    for (let t = 0; t < 40 && !start; t++) {
      const i = rng.int(0, g.w * g.h - 1);
      if (g.zone[i] === ZONE.CORRIDOR || t > 30) start = { x: i % g.w, y: (i / g.w) | 0 };
    }
    const horizontal = rng.chance(0.5);
    const len = rng.int(8, 15);
    const dir = horizontal ? 1 : 2;
    const side = horizontal ? [0, 2] : [1, 3];
    const cells = [];
    for (let s = 0; s < len; s++) {
      const x = start.x + (horizontal ? s : 0);
      const y = start.y + (horizontal ? 0 : s);
      if (!inBounds(g, x, y)) break;
      cells.push({ x, y });
    }
    if (cells.length < 6) continue;
    cells.forEach((cell, idx) => {
      if (idx < cells.length - 1) setWall(g, cell.x, cell.y, dir, 0);
      const nearSpawn = Math.abs(cell.x - spawn.x) <= 1 && Math.abs(cell.y - spawn.y) <= 1;
      // Tight side walls with occasional doorways make the corridor read as one long space.
      for (const sd of side) {
        if (nearSpawn) continue;
        setWall(g, cell.x, cell.y, sd, rng.chance(0.2) ? 0 : 1);
      }
      g.zone[cell.y * g.w + cell.x] = g.zone[cell.y * g.w + cell.x] === ZONE.DARK ? ZONE.DARK : ZONE.CORRIDOR;
    });
    // Corridors must not end in pillars.
    for (const cell of cells) {
      for (const [ci, cj] of [
        [cell.x, cell.y],
        [cell.x + 1, cell.y],
        [cell.x, cell.y + 1],
        [cell.x + 1, cell.y + 1],
      ]) {
        g.pillar[cj * (g.w + 1) + ci] = 0;
      }
    }
  }
}

function placeSolidBlocks(g, rng, spawn) {
  const count = rng.int(3, 6);
  for (let b = 0; b < count; b++) {
    const i = rng.int(0, g.w * g.h - 1);
    const x0 = i % g.w;
    const y0 = (i / g.w) | 0;
    const zone = g.zone[i];
    if (zone !== ZONE.HALL && zone !== ZONE.OFFICE) continue;
    const bw = rng.int(1, 2);
    const bh = bw === 2 ? 1 : rng.int(1, 2);
    if (x0 + bw >= g.w - 1 || y0 + bh >= g.h - 1 || x0 < 1 || y0 < 1) continue;
    if (Math.abs(x0 - spawn.x) < 4 && Math.abs(y0 - spawn.y) < 4) continue;
    for (let y = y0; y < y0 + bh; y++) {
      for (let x = x0; x < x0 + bw; x++) {
        g.solid[y * g.w + x] = 1;
        for (let d = 0; d < 4; d++) setWall(g, x, y, d, 1);
      }
    }
    for (let j = y0; j <= y0 + bh; j++) for (let c = x0; c <= x0 + bw; c++) g.pillar[j * (g.w + 1) + c] = 0;
  }
}

function braid(g, rng, chance) {
  const order = rng.shuffle([...Array(g.w * g.h).keys()]);
  for (const i of order) {
    if (g.solid[i]) continue;
    const x = i % g.w;
    const y = (i / g.w) | 0;
    if (openCount(g, x, y) !== 1 || !rng.chance(chance)) continue;
    const options = [];
    for (let d = 0; d < 4; d++) {
      const nx = x + DIRS[d].dx;
      const ny = y + DIRS[d].dy;
      if (inBounds(g, nx, ny) && !g.solid[ny * g.w + nx] && hasWall(g, x, y, d)) options.push(d);
    }
    if (options.length) setWall(g, x, y, rng.pick(options), 0);
  }
}

function openRandomWalls(g, rng, count) {
  for (let c = 0; c < count; c++) {
    const x = rng.int(0, g.w - 1);
    const y = rng.int(0, g.h - 1);
    const d = rng.int(0, 3);
    const nx = x + DIRS[d].dx;
    const ny = y + DIRS[d].dy;
    if (!inBounds(g, nx, ny) || g.solid[y * g.w + x] || g.solid[ny * g.w + nx]) continue;
    setWall(g, x, y, d, 0);
  }
}

function repairConnectivity(g, rng, spawnIndex) {
  for (let guard = 0; guard < g.w * g.h; guard++) {
    const dist = bfsDistances(g, spawnIndex);
    let fixed = false;
    let missing = false;
    const order = rng.shuffle([...Array(g.w * g.h).keys()]);
    for (const i of order) {
      if (g.solid[i] || dist[i] !== -1) continue;
      missing = true;
      const x = i % g.w;
      const y = (i / g.w) | 0;
      for (let d = 0; d < 4 && !fixed; d++) {
        const nx = x + DIRS[d].dx;
        const ny = y + DIRS[d].dy;
        if (!inBounds(g, nx, ny)) continue;
        const ni = ny * g.w + nx;
        if (!g.solid[ni] && dist[ni] >= 0) {
          setWall(g, x, y, d, 0);
          fixed = true;
        }
      }
      if (fixed) break;
    }
    if (!missing) return;
    if (!fixed) {
      // Unreached pocket with no reached neighbour: open towards any open neighbour and retry.
      for (const i of order) {
        if (g.solid[i] || dist[i] !== -1) continue;
        const x = i % g.w;
        const y = (i / g.w) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = x + DIRS[d].dx;
          const ny = y + DIRS[d].dy;
          if (inBounds(g, nx, ny) && !g.solid[ny * g.w + nx]) setWall(g, x, y, d, 0);
        }
        break;
      }
    }
  }
}

function pickSpawnYaw(g, spawn, rng) {
  const open = [];
  for (let d = 0; d < 4; d++) if (canMove(g, spawn.x, spawn.y, d)) open.push(d);
  const d = open.length ? rng.pick(open) : 0;
  // yaw 0 looks towards -z (north); positive yaw turns left (towards -x).
  return [0, -Math.PI / 2, Math.PI, Math.PI / 2][d];
}

function placeLamps(g, rng) {
  const lamps = [];
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const i = y * g.w + x;
      if (g.solid[i] || (x + y) % 2 !== 0) continue;
      const zone = g.zone[i];
      const [pNormal, pFlicker] = LAMP_ODDS[zone];
      const roll = rng.next();
      let kind = roll < pNormal ? "normal" : roll < pNormal + pFlicker ? "flicker" : "off";
      if (zone === ZONE.RED) kind = "red";
      const wallsEW = hasWall(g, x, y, 1) && hasWall(g, x, y, 3);
      const wallsNS = hasWall(g, x, y, 0) && hasWall(g, x, y, 2);
      const axis = wallsEW ? "z" : wallsNS ? "x" : rng.chance(0.5) ? "x" : "z";
      lamps.push({ index: i, x, y, axis, kind, zone, phase: rng.range(0, 1000) });
    }
  }
  return lamps;
}

function placeProps(g, rng, reserved, exit, power, tape) {
  const props = [];
  const floorUsed = new Set(reserved);
  const wallUsed = new Set([`${exit.index}:${exit.dir}`, `${power.index}:${power.dir}`, `${tape.index}:${tape.dir}`]);
  const n = g.w * g.h;

  const freeCells = () => {
    const out = [];
    for (let i = 0; i < n; i++) if (!g.solid[i] && !floorUsed.has(i)) out.push(i);
    return out;
  };
  const walls = (i, interiorOnly) => {
    const x = i % g.w;
    const y = (i / g.w) | 0;
    const out = [];
    for (let d = 0; d < 4; d++) {
      if (!hasWall(g, x, y, d) || wallUsed.has(`${i}:${d}`)) continue;
      if (interiorOnly && isBorderEdge(g, x, y, d)) continue;
      out.push(d);
    }
    return out;
  };

  function addFloor(type, count, pred = () => true, needsWall = false) {
    const cells = rng.shuffle(freeCells().filter(pred));
    let placed = 0;
    for (const i of cells) {
      if (placed >= count) break;
      const ws = walls(i, false);
      if (needsWall && !ws.length) continue;
      const dir = ws.length ? rng.pick(ws) : rng.int(0, 3);
      floorUsed.add(i);
      props.push({ type, index: i, x: i % g.w, y: (i / g.w) | 0, dir, variant: rng.int(0, 3), u: rng.range(-0.7, 0.7), rot: rng.range(-Math.PI, Math.PI) });
      placed++;
    }
  }

  function addWall(type, count, pred = () => true, interiorOnly = false) {
    const cells = rng.shuffle([...Array(n).keys()].filter((i) => !g.solid[i] && pred(i)));
    let placed = 0;
    for (const i of cells) {
      if (placed >= count) break;
      const ws = walls(i, interiorOnly);
      if (!ws.length) continue;
      const dir = rng.pick(ws);
      wallUsed.add(`${i}:${dir}`);
      props.push({ type, index: i, x: i % g.w, y: (i / g.w) | 0, dir, variant: rng.int(0, 3), u: rng.range(-0.6, 0.6), rot: 0 });
      placed++;
    }
  }

  addFloor("chair", rng.int(7, 10));
  addFloor("desk", rng.int(2, 4), (i) => g.zone[i] === ZONE.OFFICE, true);
  addFloor("boxes", rng.int(3, 5), () => true, true);
  addFloor("wetSign", rng.int(1, 2), (i) => g.zone[i] === ZONE.DAMP || g.zone[i] === ZONE.OFFICE);
  addFloor("fallenTile", rng.int(3, 5));
  addWall("wallStain", rng.int(18, 26), (i) => g.zone[i] !== ZONE.RED || rng.chance(0.3));
  addWall("vent", rng.int(5, 8));
  addWall("fakeDoor", rng.int(2, 3), () => true, true);
  addWall("scribble", rng.int(3, 5));

  // Floor stains may share cells with other props; damp zones get more of them.
  const stainCells = rng.shuffle([...Array(n).keys()].filter((i) => !g.solid[i]));
  let stains = 0;
  for (const i of stainCells) {
    if (stains >= 22) break;
    const damp = g.zone[i] === ZONE.DAMP;
    if (!damp && !rng.chance(0.3)) continue;
    props.push({ type: "floorStain", index: i, x: i % g.w, y: (i / g.w) | 0, dir: 0, variant: rng.int(0, 3), u: rng.range(-0.6, 0.6), rot: rng.range(-Math.PI, Math.PI) });
    stains++;
  }
  return props;
}

// Returns a list of human-readable problems; empty means the map is playable.
export function validateMap(map) {
  const errors = [];
  const g = map.grid;
  const n = g.w * g.h;
  const dist = bfsDistances(g, map.spawn.index);
  const walkable = (i) => i >= 0 && i < n && !g.solid[i] && dist[i] >= 0;

  for (let i = 0; i < n; i++) {
    if (!g.solid[i] && dist[i] < 0) {
      errors.push(`cell ${i} unreachable`);
      break;
    }
  }

  const { power, tape, exit } = map.objectives;
  const keyCells = { spawn: map.spawn.index, power: power.index, tape: tape.index, exit: exit.index, monster: map.monsterSpawn };
  for (const [name, i] of Object.entries(keyCells)) if (!walkable(i)) errors.push(`${name} not walkable`);
  if (new Set(Object.values(keyCells)).size !== Object.keys(keyCells).length) errors.push("key cells overlap");

  const px = (i) => i % g.w;
  const py = (i) => (i / g.w) | 0;
  if (!hasWall(g, px(power.index), py(power.index), power.dir)) errors.push("panel not on a wall");
  if (!hasWall(g, px(tape.index), py(tape.index), tape.dir)) errors.push("tv not on a wall");
  if (!isBorderEdge(g, px(exit.index), py(exit.index), exit.dir)) errors.push("exit not on outer wall");

  const minGap = map.relaxed ? 6 : 10;
  if (dist[power.index] < minGap) errors.push("panel too close to spawn");
  if (dist[exit.index] < minGap * 1.5) errors.push("exit too close to spawn");
  if (dist[map.monsterSpawn] < minGap) errors.push("creature spawns too close");
  if (cellsAligned(g, map.spawn.index, map.monsterSpawn)) errors.push("creature visible from spawn");

  for (const b of map.batteries) if (!walkable(b)) errors.push("battery not walkable");
  if (map.batteries.length < 4) errors.push("too few batteries");

  const blockingFloor = new Set(["chair", "desk", "boxes", "wetSign", "fallenTile"]);
  const floorCells = new Set();
  for (const p of map.props) {
    if (!walkable(p.index)) errors.push(`${p.type} not walkable`);
    if (blockingFloor.has(p.type)) {
      if (Object.values(keyCells).includes(p.index) || map.batteries.includes(p.index)) errors.push(`${p.type} on key cell`);
      if (floorCells.has(p.index)) errors.push(`${p.type} overlaps prop`);
      floorCells.add(p.index);
    }
    if ((p.type === "desk" || p.type === "boxes" || ["wallStain", "vent", "fakeDoor", "scribble"].includes(p.type)) && !hasWall(g, p.x, p.y, p.dir)) {
      errors.push(`${p.type} not on a wall`);
    }
    if (p.index === exit.index && p.dir === exit.dir) errors.push("prop on exit door");
  }
  return errors;
}
