import { test } from "node:test";
import assert from "node:assert/strict";
import { createStamina, STAMINA } from "../scripts/game/stamina.js";

test("sprint drains, exhaustion has hysteresis, regen waits for the delay", () => {
  const s = createStamina();
  let st;
  let t = 0;
  do {
    st = s.update(0.1, { moving: true, wantsSprint: true });
    t += 0.1;
  } while (st.sprinting && t < 20);
  assert.ok(t > 7 && t < 10, `sprint lasted ${t}`);
  assert.equal(st.exhausted, true);
  // Still exhausted right after a tiny recovery: no on/off flicker.
  st = s.update(1.2, { moving: false, wantsSprint: false });
  st = s.update(0.1, { moving: true, wantsSprint: true });
  assert.equal(st.sprinting, false);
  for (let i = 0; i < 40; i++) st = s.update(0.1, { moving: false, wantsSprint: false });
  assert.ok(st.value >= STAMINA.recoverAt);
  st = s.update(0.1, { moving: true, wantsSprint: true });
  assert.equal(st.sprinting, true);
});

test("walking is never blocked and breathing exertion rises with sprinting", () => {
  const s = createStamina();
  let st;
  for (let i = 0; i < 100; i++) st = s.update(0.1, { moving: true, wantsSprint: true });
  assert.ok(st.exertion > 0.5);
  st = s.update(0.1, { moving: true, wantsSprint: false });
  assert.equal(st.sprinting, false); // walking still fine; movement is decided by the player module
});
