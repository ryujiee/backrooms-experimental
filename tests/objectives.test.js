import { test } from "node:test";
import assert from "node:assert/strict";
import { createObjectives } from "../scripts/game/objectives.js";

const points = { power: { x: 0, z: -1 }, tape: { x: 10, z: -1 }, exit: { x: 20, z: -1 } };
const at = (x) => ({ x, z: 0, fx: 0, fz: -1 });

test("steps complete in order; hold requires holding; exit is locked until reached", () => {
  const o = createObjectives(points);
  let r = o.update(0.1, at(20), { pressed: true, held: true });
  assert.equal(r.message, "Trancada. Não há energia.");
  assert.equal(o.step, 0);
  r = o.update(0.1, at(10), { pressed: true, held: false });
  assert.equal(r.completed, null, "tape not available yet");
  for (let i = 0; i < 20; i++) r = o.update(0.1, at(0), { pressed: false, held: true });
  assert.equal(o.step, 0, "not enough hold time yet");
  r = {};
  for (let i = 0; i < 20 && !r.completed; i++) r = o.update(0.1, at(0), { pressed: false, held: true });
  assert.equal(r.completed, "power");
  r = o.update(0.1, at(20), { pressed: true, held: false });
  assert.equal(r.message, "Trancada. Falta alguma coisa.");
  r = o.update(0.1, at(10), { pressed: true, held: false });
  assert.equal(r.completed, "tape");
  r = {};
  for (let i = 0; i < 40 && !r.completed; i++) r = o.update(0.1, at(20), { pressed: false, held: true });
  assert.equal(r.completed, "exit");
  assert.equal(o.current.id, "escape");
  r = {};
  for (let i = 0; i < 300 && !r.completed; i++) r = o.update(0.1, at(0), { pressed: false, held: false });
  assert.equal(r.completed, "escape");
  assert.equal(o.current.id, "leave");
  assert.equal(o.completedCount, 3);
});

test("releasing the hold decays progress", () => {
  const o = createObjectives(points);
  let r;
  for (let i = 0; i < 15; i++) r = o.update(0.1, at(0), { pressed: false, held: true });
  const p = r.progress;
  r = o.update(0.5, at(0), { pressed: false, held: false });
  assert.ok(r.progress < p);
});

test("must face the target to interact", () => {
  const o = createObjectives(points);
  const r = o.update(0.1, { x: 0, z: 0.5, fx: 0, fz: 1 }, { pressed: true, held: true });
  assert.equal(r.prompt, null);
});
