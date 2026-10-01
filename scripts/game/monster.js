import { cellCenter, worldToIndex } from "./grid.js";
import { findPath, bfsDistances, cellsWithin } from "./pathfinding.js";

// Creature brain + locomotion (no rendering). Perceives the player through sight
// (distance, cone, line of sight, light, flashlight, crouch) and sound (noise
// events attenuated by walls). It never reads the player's position unless it can
// see or hear them; patrol targets use coarse distance bands only.

export const S = {
  DORMANT: "DORMANT",
  IDLE: "IDLE",
  PATROL: "PATROL",
  INVESTIGATE: "INVESTIGATE",
  SEARCH: "SEARCH",
  STALK: "STALK",
  CROSS: "CROSS",
  ALERT: "ALERT",
  CHASE: "CHASE",
  COOLDOWN: "COOLDOWN",
  ATTACK: "ATTACK",
};

export const AI = {
  radius: 0.38,
  catchDist: 1.0,
  turnRate: 5.5,
  accel: 5,
  fovCos: Math.cos((65 * Math.PI) / 180),
  closeSense: 2.2,
  stride: 1.5,
  repathChase: 0.35,
};

// Threat ramps with progression (objectives completed).
export const STAGES = [
  { vision: 9, hearing: 0.25, canChase: false, patrol: 1.1, investigate: 1.5, chase: 0, search: 8, band: [16, 99] },
  { vision: 14, hearing: 0.6, canChase: false, patrol: 1.3, investigate: 1.9, chase: 0, search: 12, band: [7, 15] },
  { vision: 18, hearing: 1.0, canChase: true, patrol: 1.45, investigate: 2.3, chase: 3.5, search: 18, band: [4, 12] },
  { vision: 22, hearing: 1.35, canChase: true, patrol: 1.75, investigate: 2.7, chase: 3.95, search: 24, band: [3, 9] },
  { vision: 24, hearing: 1.5, canChase: true, patrol: 2.0, investigate: 3.0, chase: 4.15, search: 30, band: [2, 7] },
];

export function createMonster({ map, collision, lightField, rng }) {
  const g = map.grid;
  const start = cellCenter(g, map.monsterSpawn % g.w, (map.monsterSpawn / g.w) | 0);
  const m = {
    pos: { x: start.x, z: start.z },
    prev: { x: start.x, z: start.z },
    yaw: 0,
    state: S.DORMANT,
    stateTime: 0,
    speed: 0,
    stage: 0,
    awareness: 0,
    seesPlayer: false,
    goal: null,
    wps: null,
    wi: 0,
    repath: 0,
    lastKnown: null,
    lastKnownVel: { x: 0, z: 0 },
    lostTime: 0,
    pause: 0,
    searchPoints: [],
    searchDuration: 0,
    stalk: null,
    observed: 0,
    cooldownDuration: 0,
    hotspot: null,
    stride: 0,
    vanishCooldown: 0,
    lookBase: 0,
    stuck: { t: 0, x: start.x, z: start.z, count: 0 },
    events: [],
    heard: null,
  };

  const cellOf = (x, z) => worldToIndex(g, x, z);
  const centerOf = (i) => cellCenter(g, i % g.w, (i / g.w) | 0);

  function setState(next) {
    if (m.state === next) return;
    m.events.push({ type: "state", from: m.state, to: next });
    m.state = next;
    m.stateTime = 0;
  }

  function goTo(x, z) {
    const path = findPath(g, cellOf(m.pos.x, m.pos.z), cellOf(x, z));
    if (!path) {
      m.goal = null;
      m.wps = null;
      return false;
    }
    m.goal = { x, z };
    m.wps = path.slice(1, -1).map(centerOf);
    m.wps.push({ x, z });
    m.wi = 0;
    m.repath = 0;
    return true;
  }

  function goToCell(i) {
    const c = centerOf(i);
    return goTo(c.x, c.z);
  }

  function clearGoal() {
    m.goal = null;
    m.wps = null;
  }

  function turnTowards(tx, tz, dt, rate = AI.turnRate) {
    const target = Math.atan2(tx - m.pos.x, tz - m.pos.z);
    let diff = target - m.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const stepMax = rate * dt;
    m.yaw += Math.max(-stepMax, Math.min(stepMax, diff));
    return Math.abs(diff);
  }

  // Advances along the current waypoints. Returns true once the goal is reached.
  function moveAlong(dt, maxSpeed) {
    if (!m.wps) {
      m.speed = Math.max(0, m.speed - AI.accel * 2 * dt);
      return true;
    }
    // String-pulling: skip waypoints we can already walk to in a straight line.
    for (let k = 0; k < 4 && m.wi + 1 < m.wps.length; k++) {
      const next = m.wps[m.wi + 1];
      if (!collision.corridorClear(m.pos.x, m.pos.z, next.x, next.z, AI.radius * 1.05)) break;
      m.wi++;
    }
    const wp = m.wps[m.wi];
    const dx = wp.x - m.pos.x;
    const dz = wp.z - m.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.3) {
      m.wi++;
      if (m.wi >= m.wps.length) {
        clearGoal();
        return true;
      }
      return false;
    }
    const angle = turnTowards(wp.x, wp.z, dt);
    const turnFactor = angle > 1.2 ? 0.45 : angle > 0.6 ? 0.75 : 1;
    const target = maxSpeed * turnFactor;
    m.speed += Math.sign(target - m.speed) * Math.min(Math.abs(target - m.speed), AI.accel * dt);
    const step = Math.min(dist, m.speed * dt);
    collision.moveCircle(m.pos, (dx / dist) * step, (dz / dist) * step, AI.radius);
    trackStride(step);
    detectStuck(dt);
    return false;
  }

  function trackStride(step) {
    m.stride += step;
    if (m.stride >= AI.stride) {
      m.stride = 0;
      m.events.push({ type: "step", x: m.pos.x, z: m.pos.z, speed: m.speed });
    }
  }

  function detectStuck(dt) {
    const s = m.stuck;
    s.t += dt;
    if (s.t < 1.2) return;
    const progress = Math.hypot(m.pos.x - s.x, m.pos.z - s.z);
    s.t = 0;
    s.x = m.pos.x;
    s.z = m.pos.z;
    if (progress > 0.25 || !m.goal) {
      s.count = 0;
      return;
    }
    s.count++;
    m.events.push({ type: "stuck", count: s.count });
    if (s.count >= 3) {
      // Hard recovery: re-centre in the current cell (always free space) and drop the goal.
      const c = centerOf(cellOf(m.pos.x, m.pos.z));
      if (!collision.overlapsCircle(c.x, c.z, AI.radius)) {
        m.pos.x = c.x;
        m.pos.z = c.z;
      }
      s.count = 0;
      clearGoal();
    } else if (m.goal) {
      goTo(m.goal.x, m.goal.z);
    }
  }

  function playerDistances(player) {
    return bfsDistances(g, cellOf(player.x, player.z));
  }

  function randomCellInBand(dist, lo, hi, tries = 120) {
    let best = -1;
    let bestScore = -Infinity;
    for (let t = 0; t < tries; t++) {
      const i = rng.int(0, g.w * g.h - 1);
      const d = dist[i];
      if (d < 0) continue;
      if (d >= lo && d <= hi) return i;
      // Remember the closest-to-band cell as a fallback.
      const score = -Math.min(Math.abs(d - lo), Math.abs(d - hi));
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  function pickPatrolGoal(ctx) {
    const st = STAGES[m.stage];
    if (m.hotspot && rng.chance(0.45)) {
      const near = cellsWithin(g, cellOf(m.hotspot.x, m.hotspot.z), 4);
      const pick = rng.pick(near);
      if (pick && goToCell(pick.index)) return;
    }
    const dist = playerDistances(ctx.player);
    const i = randomCellInBand(dist, st.band[0], st.band[1]);
    if (i >= 0) goToCell(i);
  }

  function startSearch(origin, short) {
    const st = STAGES[m.stage];
    const originCell = cellOf(origin.x, origin.z);
    const vel = m.lastKnownVel;
    const around = cellsWithin(g, originCell, short ? 2 : 4).filter((c) => c.index !== originCell);
    // Prefer cells in the direction the player was last moving.
    around.sort((a, b) => scoreDir(b.index) - scoreDir(a.index));
    function scoreDir(i) {
      const c = centerOf(i);
      return (c.x - origin.x) * vel.x + (c.z - origin.z) * vel.z + rng.next() * 6;
    }
    m.searchPoints = around.slice(0, short ? 2 : rng.int(3, 5)).map((c) => c.index);
    m.searchDuration = short ? st.search * 0.5 : st.search;
    m.pause = 0.6;
    clearGoal();
    setState(S.SEARCH);
    m.events.push({ type: "search", x: origin.x, z: origin.z });
  }

  function startRetreat(ctx, minCells = 12) {
    const dist = playerDistances(ctx.player);
    const i = randomCellInBand(dist, minCells, minCells + 18);
    if (i >= 0) goToCell(i);
    m.cooldownDuration = rng.range(22, 38);
    m.awareness = 0;
    setState(S.COOLDOWN);
  }

  function investigate(x, z) {
    if (goTo(x, z)) setState(S.INVESTIGATE);
  }

  function perceive(dt, ctx) {
    const p = ctx.player;
    const st = STAGES[m.stage];
    m.seesPlayer = false;
    m.heard = null;
    if (m.state === S.DORMANT || m.state === S.ATTACK || ctx.grace) {
      m.awareness = Math.max(0, m.awareness - dt);
      return;
    }
    const dx = p.x - m.pos.x;
    const dz = p.z - m.pos.z;
    const dist = Math.hypot(dx, dz) || 0.001;

    let vis = 0.3 + Math.min(1, lightField.sample(p.x, p.z)) * 0.75;
    if (p.flashlightOn) {
      vis = Math.max(vis, 0.85);
      const beamDot = (p.dirX * -dx + p.dirZ * -dz) / dist;
      if (beamDot > 0.9) vis *= 1.35;
    }
    if (p.crouch > 0.5) vis *= 0.7;
    const relief = m.state === S.COOLDOWN ? 0.5 : 1;
    const range = st.vision * vis * relief;
    const cosA = (dx * Math.sin(m.yaw) + dz * Math.cos(m.yaw)) / dist;
    const inCone = cosA > AI.fovCos || dist < AI.closeSense;
    if (dist < range && inCone && collision.segmentClear(m.pos.x, m.pos.z, p.x, p.z)) {
      m.seesPlayer = true;
      const rate = (0.6 + 2.4 * (1 - dist / range)) * vis;
      m.awareness = Math.min(1, m.awareness + rate * dt);
      m.lastKnown = { x: p.x, z: p.z };
      m.lastKnownVel = { x: p.vx, z: p.vz };
    } else {
      m.awareness = Math.max(0, m.awareness - dt * (m.state === S.CHASE ? 0.12 : 0.3));
    }

    const deaf = [S.COOLDOWN, S.CHASE, S.ALERT, S.STALK, S.CROSS].includes(m.state);
    if (deaf || st.hearing <= 0) return;
    let best = null;
    for (const n of ctx.noises) {
      const d = Math.hypot(n.x - m.pos.x, n.z - m.pos.z);
      const eff = collision.segmentClear(m.pos.x, m.pos.z, n.x, n.z) ? d : d * 1.7;
      const margin = n.radius * st.hearing - eff;
      if (margin > 0 && (!best || margin > best.margin)) best = { n, eff, margin };
    }
    if (best) {
      // Sound gives an approximate location only; error grows with distance.
      const err = Math.min(4, best.eff * 0.18);
      m.heard = {
        x: best.n.x + rng.range(-err, err),
        z: best.n.z + rng.range(-err, err),
        source: best.n.type,
      };
    }
  }

  function update(dt, ctx) {
    m.prev.x = m.pos.x;
    m.prev.z = m.pos.z;
    m.stateTime += dt;
    m.vanishCooldown = Math.max(0, m.vanishCooldown - dt);
    const st = STAGES[m.stage];
    const p = ctx.player;

    perceive(dt, ctx);

    const dx = p.x - m.pos.x;
    const dz = p.z - m.pos.z;
    const dist = Math.hypot(dx, dz);

    // Contact rules.
    if (m.state !== S.DORMANT && m.state !== S.ATTACK && !ctx.grace) {
      if (st.canChase) {
        if (dist < AI.catchDist && !ctx.godMode && collision.segmentClear(m.pos.x, m.pos.z, p.x, p.z)) {
          setState(S.ATTACK);
          clearGoal();
          m.events.push({ type: "caught" });
          return;
        }
      } else if (dist < 3.2 && m.vanishCooldown <= 0 && m.state !== S.COOLDOWN) {
        // Early stages: getting close makes it vanish (contextual scare, never a death).
        m.vanishCooldown = 30;
        m.events.push({ type: "vanish", x: m.pos.x, z: m.pos.z });
        startRetreat(ctx, 16);
        m.events.push({ type: "relocateFar" });
        return;
      }
    }

    // Reactions to perception.
    const calm = [S.IDLE, S.PATROL, S.SEARCH, S.INVESTIGATE].includes(m.state);
    if (m.seesPlayer && m.awareness >= 1 && (calm || m.state === S.CROSS)) {
      if (st.canChase) {
        setState(S.ALERT);
        clearGoal();
        m.events.push({ type: "screech", x: m.pos.x, z: m.pos.z });
      } else if (m.state !== S.STALK) {
        beginStalk({ x: m.pos.x, z: m.pos.z, watch: rng.range(1.2, 2.2), timeout: 6 });
      }
    } else if (m.seesPlayer && m.awareness >= 0.45 && calm && m.state !== S.INVESTIGATE) {
      investigate(p.x, p.z);
    } else if (m.heard && calm) {
      const far = !m.goal || Math.hypot(m.goal.x - m.heard.x, m.goal.z - m.heard.z) > 2.5;
      if (m.state !== S.INVESTIGATE || far) {
        investigate(m.heard.x, m.heard.z);
        m.events.push({ type: "heard", x: m.heard.x, z: m.heard.z });
      }
    }

    switch (m.state) {
      case S.DORMANT:
        if (!ctx.grace) setState(S.PATROL);
        break;
      case S.IDLE:
        m.pause -= dt;
        m.yaw = m.lookBase + Math.sin(m.stateTime * 0.9) * 0.9;
        m.speed = 0;
        if (m.pause <= 0) setState(S.PATROL);
        break;
      case S.PATROL:
        if (!m.goal) pickPatrolGoal(ctx);
        if (moveAlong(dt, st.patrol)) {
          m.pause = rng.range(1, 4);
          m.lookBase = m.yaw;
          setState(S.IDLE);
        }
        break;
      case S.INVESTIGATE:
        if (moveAlong(dt, st.investigate)) startSearch(m.pos, true);
        break;
      case S.SEARCH:
        if (m.stateTime > m.searchDuration) {
          startRetreat(ctx);
          break;
        }
        if (m.pause > 0) {
          m.pause -= dt;
          m.yaw = m.lookBase + Math.sin(m.stateTime * 1.4) * 1.1;
          m.speed = 0;
        } else if (!m.goal) {
          const next = m.searchPoints.shift();
          if (next === undefined) startRetreat(ctx);
          else goToCell(next);
        } else if (moveAlong(dt, st.investigate * 0.85)) {
          m.pause = rng.range(0.8, 2);
          m.lookBase = m.yaw;
        }
        break;
      case S.STALK: {
        m.speed = 0;
        turnTowards(p.x, p.z, dt, 2.5);
        if (ctx.playerSeesMonster) m.observed += dt;
        if (m.observed >= m.stalk.watch || m.stateTime >= m.stalk.timeout) {
          m.events.push({ type: "stalkEnd", seen: m.observed > 0.3 });
          startRetreat(ctx, 10);
        }
        break;
      }
      case S.CROSS:
        if (moveAlong(dt, 2.1)) {
          m.events.push({ type: "stalkEnd", seen: ctx.playerSeesMonster });
          startRetreat(ctx, 10);
        }
        break;
      case S.ALERT:
        turnTowards(p.x, p.z, dt, 8);
        m.speed = 0;
        if (m.stateTime > 0.65) {
          m.lostTime = 0;
          setState(S.CHASE);
          m.events.push({ type: "chaseStart" });
        }
        break;
      case S.CHASE:
        updateChase(dt, ctx, st);
        break;
      case S.COOLDOWN:
        // Relief phase: walk away, then linger until the cooldown ends.
        if (m.goal) {
          if (moveAlong(dt, st.patrol * 1.25)) m.lookBase = m.yaw;
        } else {
          m.speed = 0;
          m.yaw = m.lookBase + Math.sin(m.stateTime * 0.5) * 0.7;
        }
        if (m.stateTime > m.cooldownDuration) setState(S.PATROL);
        break;
      default:
        break;
    }
  }

  function updateChase(dt, ctx, st) {
    const p = ctx.player;
    if (m.seesPlayer) {
      m.lostTime = 0;
      if (collision.corridorClear(m.pos.x, m.pos.z, p.x, p.z, AI.radius)) {
        // Direct pursuit while the way is clear.
        m.wps = [{ x: p.x, z: p.z }];
        m.wi = 0;
        m.goal = { x: p.x, z: p.z };
      } else {
        m.repath -= dt;
        if (m.repath <= 0 || !m.goal) {
          goTo(p.x, p.z);
          m.repath = AI.repathChase;
        }
      }
    } else {
      m.lostTime += dt;
      m.repath -= dt;
      if (m.lastKnown && (m.repath <= 0 || !m.goal)) {
        goTo(m.lastKnown.x, m.lastKnown.z);
        m.repath = 1.0;
      }
    }
    // Ramp to full speed so the first second of a chase is escapable.
    const ramp = Math.min(1, 0.55 + m.stateTime * 0.3);
    const arrived = moveAlong(dt, st.chase * ramp);
    const lostLong = m.lostTime > 6;
    const reachedLastKnown = !m.seesPlayer && (arrived || !m.goal) && m.lostTime > 0.3;
    if (lostLong || reachedLastKnown) {
      m.events.push({ type: "chaseEnd" });
      const v = m.lastKnownVel;
      const origin = m.lastKnown || m.pos;
      const predicted = { x: origin.x + v.x * 1.5, z: origin.z + v.z * 1.5 };
      const ok = collision.segmentClear(origin.x, origin.z, predicted.x, predicted.z);
      startSearch(ok ? predicted : origin, false);
    }
  }

  function beginStalk(spot) {
    m.stalk = spot;
    m.observed = 0;
    clearGoal();
    setState(S.STALK);
  }

  return {
    m,
    update,
    get pos() {
      return m.pos;
    },
    get prev() {
      return m.prev;
    },
    get state() {
      return m.state;
    },
    setStage(stage) {
      m.stage = Math.max(0, Math.min(STAGES.length - 1, stage));
    },
    setHotspot(point) {
      m.hotspot = point;
    },
    drainEvents() {
      const out = m.events;
      m.events = [];
      return out;
    },
    // Director-driven presence. All teleports are validated by the caller (out of view, far away).
    relocate(x, z) {
      m.pos.x = m.prev.x = x;
      m.pos.z = m.prev.z = z;
      m.speed = 0;
      m.stuck = { t: 0, x, z, count: 0 };
      clearGoal();
    },
    stalkAt(spot, yawTowards) {
      this.relocate(spot.x, spot.z);
      m.yaw = Math.atan2(yawTowards.x - spot.x, yawTowards.z - spot.z);
      beginStalk({ ...spot, watch: rng.range(1.5, 3), timeout: rng.range(12, 18) });
    },
    crossAt(from, to) {
      this.relocate(from.x, from.z);
      if (goTo(to.x, to.z)) setState(S.CROSS);
    },
    alertTo(x, z) {
      if ([S.IDLE, S.PATROL, S.SEARCH, S.COOLDOWN, S.DORMANT].includes(m.state)) investigate(x, z);
    },
    retreat(ctx) {
      startRetreat(ctx);
    },
    isHunting: () => m.state === S.CHASE || m.state === S.ALERT,
    isCalm: () => [S.IDLE, S.PATROL, S.COOLDOWN, S.DORMANT].includes(m.state),
    debugPath: () => (m.wps ? m.wps.slice(m.wi) : []),
  };
}
