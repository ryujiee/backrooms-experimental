import { test } from "node:test";
import assert from "node:assert/strict";
import { generateMap } from "../scripts/game/procgen.js";
import { createCollision } from "../scripts/game/collision.js";
import { createGrid, setWall, cellCenter, CELL } from "../scripts/game/grid.js";

function boxMap() {
  // 3x3 open room surrounded by outer walls, with one wall inside.
  const g = createGrid(3, 3);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
    if (x < 2) setWall(g, x, y, 1, 0);
    if (y < 2) setWall(g, x, y, 2, 0);
  }
  setWall(g, 1, 1, 1, 1); // wall between (1,1) and (2,1)
  return { grid: g, props: [] };
}

test("cannot tunnel through a wall even with a huge step", () => {
  const map = boxMap();
  const col = createCollision(map);
  const c = cellCenter(map.grid, 1, 1);
  const pos = { x: c.x, z: c.z };
  col.moveCircle(pos, CELL * 3, 0, 0.3); // 9 m in one call
  const wallX = cellCenter(map.grid, 1, 1).x + CELL / 2;
  assert.ok(pos.x < wallX - 0.3 + 1e-6, `crossed wall: ${pos.x} vs ${wallX}`);
});

test("cannot leave the map through corners", () => {
  const map = boxMap();
  const col = createCollision(map);
  const c = cellCenter(map.grid, 0, 0);
  const pos = { x: c.x, z: c.z };
  for (let i = 0; i < 200; i++) col.moveCircle(pos, -0.2, -0.2, 0.3);
  const minX = -1.5 * CELL + 0.1 + 0.3;
  assert.ok(pos.x >= minX - 1e-6 && pos.z >= minX - 1e-6, `left map: ${pos.x},${pos.z}`);
  // And it slides out of the corner instead of sticking.
  col.moveCircle(pos, 0.5, 0, 0.3);
  assert.ok(pos.x > minX + 0.4);
});

test("random walks on real maps never end inside geometry", () => {
  for (const seed of ["a", "b", "c", "d"]) {
    const map = generateMap(seed);
    const col = createCollision(map);
    const g = map.grid;
    const s = cellCenter(g, map.spawn.index % g.w, (map.spawn.index / g.w) | 0);
    const pos = { x: s.x, z: s.z };
    let ang = 0;
    for (let i = 0; i < 6000; i++) {
      ang += Math.sin(i * 0.37) * 0.6 + 0.05;
      col.moveCircle(pos, Math.cos(ang) * 0.12, Math.sin(ang) * 0.12, 0.3);
      assert.ok(!col.overlapsCircle(pos.x, pos.z, 0.28), `${seed}: stuck in geometry at step ${i}`);
    }
  }
});

test("line of sight is blocked by walls and clear across open rooms", () => {
  const map = boxMap();
  const col = createCollision(map);
  const a = cellCenter(map.grid, 1, 1);
  const b = cellCenter(map.grid, 2, 1);
  const c = cellCenter(map.grid, 0, 1);
  assert.equal(col.segmentClear(a.x, a.z, b.x, b.z), false);
  assert.equal(col.segmentClear(a.x, a.z, c.x, c.z), true);
});

test("light field: incremental (dirty-row) encode matches a full encode", async () => {
  const { createLightField } = await import("../scripts/game/lightfield.js");
  const map = generateMap("lf");
  const col = createCollision(map);
  const a = createLightField(map, col);
  map.lamps.forEach((l, i) => a.setLampLevel(i, l.kind === "off" ? 0 : 1));
  a.encode();
  for (let k = 0; k < 200; k++) {
    a.setLampLevel((k * 37) % map.lamps.length, (k % 3) / 2);
    if (k % 7 === 0) a.encode();
  }
  const incremental = Uint8Array.from(a.encode());
  const b = createLightField(map, col);
  map.lamps.forEach((_, i) => b.setLampLevel(i, a.getLampLevel(i)));
  const full = b.encode();
  let maxDiff = 0;
  for (let i = 0; i < full.length; i++) maxDiff = Math.max(maxDiff, Math.abs(full[i] - incremental[i]));
  assert.ok(maxDiff <= 1, `max byte difference ${maxDiff}`);
});
