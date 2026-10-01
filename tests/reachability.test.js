import { test } from "node:test";
import assert from "node:assert/strict";
import { generateMap } from "../scripts/game/procgen.js";
import { createCollision } from "../scripts/game/collision.js";
import { createPlayer } from "../scripts/game/player.js";
import { objectiveTransforms } from "../scripts/game/placement.js";
import { cellCenter, worldToCell } from "../scripts/game/grid.js";
import { findPath } from "../scripts/game/pathfinding.js";

// Walks a real player body (radius, collision, sub-steps) from the spawn to every
// objective along the grid path. Catches props or geometry that block a passage
// the pathfinder believes is open.
function walkTo(map, col, player, target, maxSeconds = 240) {
  const g = map.grid;
  const dt = 1 / 60;
  for (let t = 0; t < maxSeconds; t += dt) {
    if (Math.hypot(target.x - player.pos.x, target.z - player.pos.z) < 1.1) return true;
    const a = worldToCell(g, player.pos.x, player.pos.z);
    const b = worldToCell(g, target.x, target.z);
    const path = findPath(g, a.y * g.w + a.x, b.y * g.w + b.x);
    let aim = target;
    if (path && path.length > 2) {
      aim = cellCenter(g, path[1] % g.w, (path[1] / g.w) | 0);
      const next = cellCenter(g, path[2] % g.w, (path[2] / g.w) | 0);
      if (col.corridorClear(player.pos.x, player.pos.z, next.x, next.z, 0.32)) aim = next;
    }
    player.yaw = Math.atan2(-(aim.x - player.pos.x), -(aim.z - player.pos.z));
    player.step(dt, { forward: 1, right: 0, sprint: false, crouch: false }, null);
  }
  return false;
}

test("a real player body can walk to the panel, the tape and the exit door on many seeds", () => {
  for (let i = 0; i < 40; i++) {
    const seed = `walk-${i}`;
    const map = generateMap(seed);
    const col = createCollision(map);
    const g = map.grid;
    const ot = objectiveTransforms(map);
    const s = cellCenter(g, map.spawn.index % g.w, (map.spawn.index / g.w) | 0);
    const player = createPlayer(col, { x: s.x, z: s.z, yaw: 0 });
    const door = { x: ot.door.x + ot.door.normal.x * 0.6, z: ot.door.z + ot.door.normal.z * 0.6 };
    for (const [name, target] of [["panel", ot.panel], ["tape", ot.tape], ["door", door]]) {
      assert.ok(walkTo(map, col, player, target), `${seed}: could not walk to ${name} (stuck at ${player.pos.x.toFixed(2)}, ${player.pos.z.toFixed(2)})`);
    }
  }
});
