import { test } from "node:test";
import assert from "node:assert/strict";
import { generateMap } from "../scripts/game/procgen.js";
import { findPath, bfsDistances } from "../scripts/game/pathfinding.js";
import { canMove, DIRS } from "../scripts/game/grid.js";

test("paths are shortest, contiguous and only use open edges", () => {
  const map = generateMap("paths");
  const g = map.grid;
  const dist = bfsDistances(g, map.spawn.index);
  for (const goal of [map.objectives.power.index, map.objectives.tape.index, map.objectives.exit.index, map.monsterSpawn]) {
    const path = findPath(g, map.spawn.index, goal);
    assert.ok(path, "path exists");
    assert.equal(path.length - 1, dist[goal]);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const ax = a % g.w, ay = (a / g.w) | 0;
      const d = DIRS.findIndex((dd) => ax + dd.dx === b % g.w && ay + dd.dy === ((b / g.w) | 0));
      assert.ok(d >= 0 && canMove(g, ax, ay, d), "step through open edge");
    }
  }
});

test("pathfinding is fast enough to call several times per second", () => {
  const map = generateMap("perf");
  const t0 = performance.now();
  for (let i = 0; i < 500; i++) findPath(map.grid, map.spawn.index, map.objectives.exit.index);
  const per = (performance.now() - t0) / 500;
  assert.ok(per < 0.5, `${per.toFixed(3)} ms per path`);
});
