import { clamp } from "../core/rng.js";

// Horror director: owns pacing. Keeps a smoothed tension value and decides when an
// environmental event or a creature appearance may happen. Every roll is gated by
// a global gap, per-event cooldowns, stage, context and a relief window after peaks,
// so there is never a per-frame Math.random() scare.

export const EVENTS = [
  { name: "humCut", minStage: 0, cooldown: 150, weight: 0.9 },
  { name: "lightOutBehind", minStage: 0, cooldown: 60, weight: 1.2 },
  { name: "distantKnock", minStage: 0, cooldown: 55, weight: 1 },
  { name: "metalGroan", minStage: 0, cooldown: 75, weight: 0.7 },
  { name: "lampPop", minStage: 0, cooldown: 45, weight: 0.8 },
  { name: "flickerWave", minStage: 1, cooldown: 95, weight: 0.9 },
  { name: "phantomSteps", minStage: 1, cooldown: 120, weight: 0.8, needs: (c) => c.playerMoving },
  { name: "distantVoice", minStage: 1, cooldown: 85, weight: 0.9 },
  { name: "objectMoved", minStage: 1, cooldown: 200, weight: 0.6, max: 2 },
  { name: "vhsGlitch", minStage: 1, cooldown: 100, weight: 0.5, boost: (c) => (c.monsterDist < 22 ? 2.5 : 0.4) },
  { name: "newDoor", minStage: 2, cooldown: 400, weight: 0.5, max: 1 },
];

const GAPS = [
  [45, 80],
  [35, 60],
  [30, 50],
  [26, 42],
  [22, 36],
];
const STALK_GAPS = [null, [75, 130], [120, 180], null, null];
const BASE_TENSION = [0.08, 0.2, 0.32, 0.5, 0.65];
const RELIEF_AFTER_CHASE = 45;
const FIRST_EVENT_AT = 40;
const HINT_AFTER = 240;

export function createDirector(rng) {
  let time = 0;
  let stage = 0;
  let stageTime = 0;
  let tension = 0;
  let boost = 0;
  let nextEventAt = FIRST_EVENT_AT + rng.range(0, 20);
  let nextStalkAt = Infinity;
  let earlyGlimpseDone = false;
  let reliefUntil = 0;
  let hintAt = HINT_AFTER;
  let wasHunting = false;
  const lastRun = {};
  const counts = {};

  function scheduleNext() {
    const [lo, hi] = GAPS[stage];
    nextEventAt = time + rng.range(lo, hi);
  }

  function scheduleStalk() {
    const gap = STALK_GAPS[stage];
    nextStalkAt = gap ? time + rng.range(gap[0], gap[1]) : Infinity;
  }

  function eligible(c) {
    return EVENTS.filter((e) => {
      if (stage < e.minStage) return false;
      if (e.max && (counts[e.name] || 0) >= e.max) return false;
      if (lastRun[e.name] !== undefined && time - lastRun[e.name] < e.cooldown) return false;
      if (e.needs && !e.needs(c)) return false;
      return true;
    }).map((e) => ({ ...e, weight: e.weight * (e.boost ? e.boost(c) : 1) }));
  }

  // ctx: { monsterDist, hunting, searching, playerDark, playerMoving, monsterCalm }
  function update(dt, ctx) {
    time += dt;
    stageTime += dt;
    const actions = [];

    if (wasHunting && !ctx.hunting) {
      reliefUntil = time + RELIEF_AFTER_CHASE;
      nextEventAt = Math.max(nextEventAt, reliefUntil + rng.range(5, 15));
      nextStalkAt = Math.max(nextStalkAt, reliefUntil + 30);
    }
    wasHunting = ctx.hunting;

    const prox = clamp(1 - ctx.monsterDist / 30, 0, 1) * (stage >= 2 ? 0.35 : 0.18);
    const threat = ctx.hunting ? 0.45 : ctx.searching && ctx.monsterDist < 20 ? 0.12 : 0;
    const target = clamp(BASE_TENSION[stage] + prox + threat + (ctx.playerDark ? 0.08 : 0) + boost, 0, 1);
    tension += (target - tension) * Math.min(1, dt * (target > tension ? 1.2 : 0.06));
    boost = Math.max(0, boost - dt * 0.04);

    const relaxed = time >= reliefUntil && !ctx.hunting;

    if (relaxed && time >= nextEventAt) {
      if (tension > 0.68) {
        nextEventAt = time + rng.range(10, 15);
      } else {
        const pick = rng.weighted(eligible(ctx));
        if (pick) actions.push({ type: "event", name: pick.name });
        scheduleNext();
      }
    }

    if (relaxed && ctx.monsterCalm) {
      if (stage === 0 && !earlyGlimpseDone && stageTime > 240) {
        earlyGlimpseDone = true;
        if (rng.chance(0.55)) actions.push({ type: "stalk" });
      } else if (time >= nextStalkAt) {
        if (stage < 2 || rng.chance(0.6)) actions.push({ type: "stalk" });
        scheduleStalk();
      }
    }

    if (time >= hintAt) {
      actions.push({ type: "hint" });
      hintAt = time + 120;
    }

    return actions;
  }

  return {
    update,
    // Called by the session once an action was actually executed (or failed for lack of a spot).
    report(name, ok) {
      if (ok) {
        lastRun[name] = time;
        counts[name] = (counts[name] || 0) + 1;
        boost = Math.min(0.3, boost + 0.12);
      } else if (name !== "stalk") {
        nextEventAt = time + rng.range(6, 12);
      }
    },
    setStage(s) {
      stage = Math.max(0, Math.min(BASE_TENSION.length - 1, s));
      stageTime = 0;
      hintAt = time + HINT_AFTER;
      boost = Math.min(0.35, boost + 0.2);
      scheduleStalk();
      nextEventAt = Math.min(nextEventAt, time + rng.range(15, 30));
    },
    progressMade() {
      hintAt = time + HINT_AFTER;
    },
    get tension() {
      return tension;
    },
    get time() {
      return time;
    },
    debug: () => ({ nextEventIn: nextEventAt - time, nextStalkIn: nextStalkAt - time, relief: Math.max(0, reliefUntil - time), stage }),
  };
}
