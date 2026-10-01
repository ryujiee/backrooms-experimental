import { test } from "node:test";
import assert from "node:assert/strict";
import { generateMap, validateMap, ZONE } from "../scripts/game/procgen.js";
import { bfsDistances } from "../scripts/game/pathfinding.js";
import { hasWall, isBorderEdge } from "../scripts/game/grid.js";

const SEEDS = Array.from({ length: 150 }, (_, i) => `seed-${i}`);

test("every seed produces a valid, fully connected map", () => {
  let relaxed = 0;
  for (const seed of SEEDS) {
    const map = generateMap(seed);
    assert.deepEqual(validateMap(map), [], `seed ${seed}`);
    const dist = bfsDistances(map.grid, map.spawn.index);
    for (let i = 0; i < dist.length; i++) {
      if (!map.grid.solid[i]) assert.ok(dist[i] >= 0, `seed ${seed}: cell ${i} unreachable`);
    }
    if (map.relaxed) relaxed++;
  }
  assert.ok(relaxed < SEEDS.length * 0.1, `too many relaxed maps: ${relaxed}`);
});

test("same seed reproduces the same map; different seeds differ", () => {
  const a = generateMap("repro");
  const b = generateMap("repro");
  const c = generateMap("other");
  assert.deepEqual(Array.from(a.grid.hWall), Array.from(b.grid.hWall));
  assert.deepEqual(a.objectives, b.objectives);
  assert.deepEqual(a.props, b.props);
  assert.notDeepEqual(Array.from(a.grid.hWall), Array.from(c.grid.hWall));
});

test("objectives are ordered by distance and the exit sits in the outer wall", () => {
  for (const seed of SEEDS.slice(0, 40)) {
    const map = generateMap(seed);
    const { power, tape, exit } = map.objectives;
    const d = map.distFromSpawn;
    const g = map.grid;
    assert.ok(d[power.index] >= 10, `${seed}: panel ${d[power.index]}`);
    assert.ok(d[exit.index] >= d[power.index], `${seed}: exit closer than panel`);
    assert.ok(isBorderEdge(g, exit.index % g.w, (exit.index / g.w) | 0, exit.dir));
    assert.ok(hasWall(g, power.index % g.w, (power.index / g.w) | 0, power.dir));
  }
});

test("maps have spatial variety (zones, halls, pillars, loops)", () => {
  for (const seed of SEEDS.slice(0, 20)) {
    const map = generateMap(seed);
    const zones = new Set(map.grid.zone);
    assert.ok(zones.has(ZONE.DARK) && zones.has(ZONE.CORRIDOR), `${seed}: zones ${[...zones]}`);
    const kinds = new Set(map.lamps.map((l) => l.kind));
    assert.ok(kinds.has("normal") && kinds.has("off"), `${seed}: lamp kinds`);
    assert.ok(map.props.length > 40, `${seed}: props ${map.props.length}`);
    // Loops: edges > cells - 1 means the graph is not a tree.
    const g = map.grid;
    let open = 0;
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      if (x + 1 < g.w && !hasWall(g, x, y, 1)) open++;
      if (y + 1 < g.h && !hasWall(g, x, y, 2)) open++;
    }
    const cells = g.solid.reduce((n, s) => n + (s ? 0 : 1), 0);
    assert.ok(open > cells * 1.15, `${seed}: too few loops (${open} edges for ${cells} cells)`);
  }
});
