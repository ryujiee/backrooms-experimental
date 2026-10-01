// Sprint stamina with a short regen delay and exhaustion hysteresis
// (once empty you must recover to RECOVER_AT before sprinting again, which
// avoids the sprint flickering on/off at the threshold). Never blocks walking.

export const STAMINA = {
  max: 100,
  drain: 12, // per second sprinting (~8 s from full)
  regenWalk: 11,
  regenIdle: 17,
  regenDelay: 1.0,
  recoverAt: 35,
};

export function createStamina(cfg = STAMINA) {
  let value = cfg.max;
  let sinceSprint = cfg.regenDelay;
  let exhausted = false;
  // Smoothed exertion 0..1 that drives breathing; decays slower than stamina recovers.
  let exertion = 0;

  function update(dt, { moving, wantsSprint }) {
    const sprinting = moving && wantsSprint && !exhausted && value > 0;
    if (sprinting) {
      value = Math.max(0, value - cfg.drain * dt);
      sinceSprint = 0;
      if (value === 0) exhausted = true;
    } else {
      sinceSprint += dt;
      if (sinceSprint >= cfg.regenDelay) {
        value = Math.min(cfg.max, value + (moving ? cfg.regenWalk : cfg.regenIdle) * dt);
      }
      if (exhausted && value >= cfg.recoverAt) exhausted = false;
    }
    const target = sprinting ? 1 - value / cfg.max * 0.5 : 1 - value / cfg.max;
    exertion += (target - exertion) * Math.min(1, dt * (target > exertion ? 1.5 : 0.35));
    return { value, max: cfg.max, sprinting, exhausted, exertion };
  }

  return {
    update,
    reset() {
      value = cfg.max;
      sinceSprint = cfg.regenDelay;
      exhausted = false;
      exertion = 0;
    },
    get value() {
      return value;
    },
  };
}
