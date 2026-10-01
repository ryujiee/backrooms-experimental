import { test } from "node:test";
import assert from "node:assert/strict";
import { createDirector, EVENTS } from "../scripts/game/director.js";
import { createRng } from "../scripts/core/rng.js";

const calm = { monsterDist: 60, hunting: false, searching: false, playerDark: false, playerMoving: true, monsterCalm: true };

function run(director, seconds, ctxFn = () => calm) {
  const out = [];
  for (let i = 0; i < seconds * 10; i++) {
    for (const a of director.update(0.1, ctxFn(i / 10))) {
      out.push({ ...a, t: director.time });
      director.report(a.type === "event" ? a.name : a.type, true);
    }
  }
  return out;
}

test("no events in the first 40 s and events are spaced by the stage gap", () => {
  for (let s = 0; s < 10; s++) {
    const d = createDirector(createRng(`d${s}`));
    const events = run(d, 900).filter((a) => a.type === "event");
    assert.ok(events.length >= 6, `only ${events.length} events in 15 min`);
    assert.ok(events[0].t >= 40);
    for (let i = 1; i < events.length; i++) assert.ok(events[i].t - events[i - 1].t >= 45 - 0.11, "gap respected at stage 0");
  }
});

test("stage gating and per-event cooldowns", () => {
  const d = createDirector(createRng("gate"));
  const stage0 = run(d, 600).filter((a) => a.type === "event");
  const allowed0 = new Set(EVENTS.filter((e) => e.minStage === 0).map((e) => e.name));
  for (const e of stage0) assert.ok(allowed0.has(e.name), e.name);
  d.setStage(2);
  const later = run(d, 1200).filter((a) => a.type === "event");
  const last = {};
  for (const e of later) {
    const def = EVENTS.find((x) => x.name === e.name);
    if (last[e.name] !== undefined) assert.ok(e.t - last[e.name] >= def.cooldown - 0.11, `${e.name} cooldown`);
    last[e.name] = e.t;
  }
});

test("relief window after a chase: nothing happens for 45 s", () => {
  const d = createDirector(createRng("relief"));
  d.setStage(2);
  run(d, 100);
  const actions = run(d, 120, (t) => ({ ...calm, hunting: t < 20, monsterDist: t < 20 ? 5 : 60 }));
  const during = actions.filter((a) => a.type !== "hint" && a.t > 100 + 20 && a.t < 100 + 20 + 45);
  assert.deepEqual(during, []);
});

test("tension rises with a chase and decays slowly afterwards", () => {
  const d = createDirector(createRng("tension"));
  d.setStage(2);
  run(d, 30);
  const base = d.tension;
  run(d, 10, () => ({ ...calm, hunting: true, monsterDist: 4 }));
  const peak = d.tension;
  run(d, 10);
  assert.ok(peak > base + 0.4, `${base} -> ${peak}`);
  assert.ok(d.tension > base && d.tension < peak);
});
