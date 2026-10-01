import { test } from "node:test";
import assert from "node:assert/strict";
import { generateMap } from "../scripts/game/procgen.js";
import { createCollision } from "../scripts/game/collision.js";
import { createMonster, S, AI } from "../scripts/game/monster.js";
import { createRng } from "../scripts/core/rng.js";
import { cellCenter, canMove, DIRS } from "../scripts/game/grid.js";

const lit = { sample: () => 0.9 };
const DT = 1 / 60;

function setup(seed, stage) {
  const map = generateMap(seed);
  const collision = createCollision(map);
  const monster = createMonster({ map, collision, lightField: lit, rng: createRng(seed) });
  monster.setStage(stage);
  return { map, collision, monster, g: map.grid };
}

function playerAt(x, z, extra = {}) {
  return { x, z, vx: 0, vz: 0, crouch: 0, flashlightOn: false, dirX: 0, dirZ: -1, ...extra };
}

test("patrols for 10 simulated minutes without getting stuck or clipping", () => {
  for (const seed of ["m1", "m2", "m3"]) {
    const { map, collision, monster, g } = setup(seed, 1);
    const s = cellCenter(g, map.spawn.index % g.w, (map.spawn.index / g.w) | 0);
    let travelled = 0;
    let hardStuck = 0;
    const cells = new Set();
    for (let i = 0; i < 60 * 600; i++) {
      monster.update(DT, { player: playerAt(s.x, s.z), noises: [], grace: false, playerSeesMonster: false });
      travelled += Math.hypot(monster.pos.x - monster.prev.x, monster.pos.z - monster.prev.z);
      for (const e of monster.drainEvents()) if (e.type === "stuck" && e.count >= 3) hardStuck++;
      if (i % 30 === 0) {
        assert.ok(!collision.overlapsCircle(monster.pos.x, monster.pos.z, AI.radius - 0.05), `${seed}: inside geometry`);
        cells.add(`${Math.round(monster.pos.x / 3)},${Math.round(monster.pos.z / 3)}`);
      }
    }
    assert.ok(travelled > 150, `${seed}: travelled only ${travelled.toFixed(1)} m`);
    assert.ok(cells.size > 25, `${seed}: visited only ${cells.size} cells`);
    assert.ok(hardStuck <= 2, `${seed}: hard stuck ${hardStuck} times`);
  }
});

function straightLine(map, len) {
  const g = map.grid;
  for (let i = 0; i < g.w * g.h; i++) {
    const x = i % g.w, y = (i / g.w) | 0;
    for (const d of [1, 2]) {
      let ok = true;
      for (let s = 0; s < len && ok; s++) ok = canMove(g, x + DIRS[d].dx * s, y + DIRS[d].dy * s, d);
      if (ok) return { a: cellCenter(g, x, y), b: cellCenter(g, x + DIRS[d].dx * len, y + DIRS[d].dy * len) };
    }
  }
  return null;
}

test("stage 2: sees a visible player, alerts, chases and catches", () => {
  const { map, monster } = setup("chase", 2);
  const line = straightLine(map, 4);
  assert.ok(line, "found a straight corridor");
  monster.relocate(line.a.x, line.a.z);
  monster.m.yaw = Math.atan2(line.b.x - line.a.x, line.b.z - line.a.z);
  monster.m.state = S.PATROL;
  const states = new Set();
  let caught = false;
  for (let i = 0; i < 60 * 15 && !caught; i++) {
    monster.update(DT, { player: playerAt(line.b.x, line.b.z), noises: [], grace: false });
    states.add(monster.state);
    caught = monster.drainEvents().some((e) => e.type === "caught");
  }
  assert.ok(states.has(S.ALERT) && states.has(S.CHASE), [...states].join(","));
  assert.ok(caught, "caught the player");
});

test("early stages never kill: getting close makes it vanish", () => {
  const { map, monster } = setup("early", 1);
  const line = straightLine(map, 2);
  monster.relocate(line.a.x, line.a.z);
  monster.m.state = S.PATROL;
  const events = [];
  for (let i = 0; i < 60 * 10; i++) {
    monster.update(DT, { player: playerAt(line.a.x + 0.5, line.a.z), noises: [], grace: false });
    events.push(...monster.drainEvents());
  }
  assert.ok(!events.some((e) => e.type === "caught"));
  assert.ok(events.some((e) => e.type === "vanish"));
});

test("hearing: distant noise ignored, nearby noise investigated with only approximate position", () => {
  const { map, monster, g } = setup("ears", 2);
  const line = straightLine(map, 3);
  monster.relocate(line.a.x, line.a.z);
  monster.m.state = S.IDLE;
  monster.m.pause = 100;
  const hidden = playerAt(9999, 9999);
  monster.update(DT, { player: hidden, noises: [{ x: line.a.x + 40, z: line.a.z, radius: 7 }], grace: false });
  assert.equal(monster.state, S.IDLE, "too far to hear");
  const noise = { x: line.b.x, z: line.b.z, radius: 17 };
  monster.update(DT, { player: hidden, noises: [noise], grace: false });
  assert.equal(monster.state, S.INVESTIGATE);
  const goal = monster.m.goal;
  assert.ok(Math.hypot(goal.x - noise.x, goal.z - noise.z) <= 4.01);
});

test("loses a player who breaks line of sight, searches, then backs off", () => {
  const { map, monster } = setup("lose", 2);
  const line = straightLine(map, 4);
  monster.relocate(line.a.x, line.a.z);
  monster.m.yaw = Math.atan2(line.b.x - line.a.x, line.b.z - line.a.z);
  monster.m.state = S.PATROL;
  for (let i = 0; i < 60 * 1.5; i++) monster.update(DT, { player: playerAt(line.b.x, line.b.z), noises: [], grace: false });
  assert.ok([S.ALERT, S.CHASE].includes(monster.state), monster.state);
  // Player vanishes far away behind walls (e.g. took a side passage) and stays silent.
  const far = playerAt(-9999, -9999);
  const seen = new Set();
  for (let i = 0; i < 60 * 90; i++) {
    monster.update(DT, { player: far, noises: [], grace: false });
    seen.add(monster.state);
  }
  assert.ok(seen.has(S.SEARCH), [...seen].join(","));
  assert.ok(seen.has(S.COOLDOWN) || seen.has(S.PATROL), [...seen].join(","));
});

test("grace period: no perception at all", () => {
  const { map, monster } = setup("grace", 3);
  const line = straightLine(map, 2);
  monster.relocate(line.a.x, line.a.z);
  for (let i = 0; i < 600; i++) monster.update(DT, { player: playerAt(line.a.x + 0.4, line.a.z), noises: [{ x: line.a.x, z: line.a.z, radius: 50 }], grace: true });
  assert.equal(monster.state, S.DORMANT);
});
