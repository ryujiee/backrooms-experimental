import * as THREE from "three";
import { createRng } from "../core/rng.js";
import { generateMap, ZONE } from "../game/procgen.js";
import { createCollision } from "../game/collision.js";
import { createLightField } from "../game/lightfield.js";
import { createPlayer, PLAYER } from "../game/player.js";
import { createMonster, S } from "../game/monster.js";
import { createDirector } from "../game/director.js";
import { createObjectives, STEPS } from "../game/objectives.js";
import { objectiveTransforms } from "../game/placement.js";
import { cellCenter, setWall, worldToCell } from "../game/grid.js";
import { findPath } from "../game/pathfinding.js";
import * as spots from "../game/spots.js";
import { createWorld, LAMP } from "./world.js";
import { createMonsterView } from "./monsterView.js";
import { FLASHLIGHT } from "./view.js";

// One run of the game (or the idle menu backdrop). Owns the map, world meshes,
// creature, director and objectives, and tears all of it down in dispose().
// Gameplay advances only in step() (fixed timestep); frame() is presentation.

const GRACE = 75; // seconds before the creature becomes active at all
const STAGE_POWER = [0.8, 1.0, 0.88, 0.95, 0.95];

const INTERACT = "KeyE";
// Loudness of the creature's breathing/growl per state (it is mostly heard before it is seen).
const CREATURE_VOICE = {
  DORMANT: 0,
  IDLE: 0.08,
  PATROL: 0.1,
  INVESTIGATE: 0.16,
  SEARCH: 0.18,
  STALK: 0.05,
  CROSS: 0.12,
  ALERT: 0.7,
  CHASE: 0.6,
  COOLDOWN: 0.05,
  ATTACK: 0.9,
};

function localRectToWorld(frame, x0, x1, z0, z1) {
  const pts = [
    [x0, z0],
    [x1, z0],
    [x0, z1],
    [x1, z1],
  ].map(([lx, lz]) => ({
    x: frame.x + frame.tangent.x * lx + frame.normal.x * lz,
    z: frame.z + frame.tangent.z * lx + frame.normal.z * lz,
  }));
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    maxX: Math.max(...pts.map((p) => p.x)),
    minZ: Math.min(...pts.map((p) => p.z)),
    maxZ: Math.max(...pts.map((p) => p.z)),
  };
}

export function createSession(opts) {
  const { seed, mode, scene, lamp, textures, quality, audio, ui, view, assets, settings, camera } = opts;
  const timeOffset = opts.timeOffset || 0;
  const menu = mode === "menu";
  const map = generateMap(seed);
  const g = map.grid;
  const rng = createRng(`${seed}:runtime`);
  const ot = objectiveTransforms(map);

  // Open the outer wall where the exit door goes; the door frame supplies its own colliders.
  const exit = map.objectives.exit;
  setWall(g, exit.index % g.w, (exit.index / g.w) | 0, exit.dir, 0);
  const d = ot.door;
  const extra = [
    localRectToWorld(d, -1.6, -0.65, -0.1, 0.1),
    localRectToWorld(d, 0.65, 1.6, -0.1, 0.1),
    { ...localRectToWorld(d, -0.65, 0.65, -0.06, 0.06), tag: "door" },
    localRectToWorld(d, -0.95, -0.65, -3.4, -0.1),
    localRectToWorld(d, 0.65, 0.95, -3.4, -0.1),
    localRectToWorld(d, -0.95, 0.95, -3.6, -3.3),
  ];
  const collision = createCollision(map, extra);
  const exitBoxes = { door: collision.extraIds[2] };
  const lightField = createLightField(map, collision);
  const world = createWorld({ scene, map, collision, lightField, lamp, textures, quality, rng, exitBoxes, materials: opts.materials });
  lamp.bind(lightField);

  const spawnC = cellCenter(g, map.spawn.index % g.w, (map.spawn.index / g.w) | 0);
  const player = createPlayer(collision, { x: spawnC.x, z: spawnC.z, yaw: map.spawn.yaw });
  const monster = createMonster({ map, collision, lightField, rng: createRng(`${seed}:creature`) });
  const monsterView = createMonsterView({ scene, model: assets.monster ? assets.monster.clone() : null, lamp });
  const director = createDirector(createRng(`${seed}:director`));
  const exitFront = { x: d.x + d.normal.x * 0.45, z: d.z + d.normal.z * 0.45 };
  const objectives = createObjectives({ power: ot.panel, tape: ot.tape, exit: exitFront });

  let stage = 0;
  let time = 0;
  let phase = menu ? "menu" : "intro";
  let wake = 0;
  let sequenceT = 0;
  let result = null;
  let pending = [];
  const noises = [];
  // The creature only plays its attack while the death sequence runs (no perception, no noise).
  const DYING_CTX = { player: { x: 0, z: 0, vx: 0, vz: 0, crouch: 0, flashlightOn: false, dirX: 0, dirZ: 0 }, noises: [], grace: true, godMode: true };
  let holdNoiseT = 0;
  let presenceT = 0;
  let buzzT = 0;
  let stalkSeen = false;
  let chaseStingerAt = -999;
  let deathYaw = 0;
  let deathPitch = 0;
  let glitch = 0;
  let flash = 0;
  let exposure = 1;
  let humCut = 0;
  let godMode = false;
  let graceUntil = GRACE;
  let inputOverride = null;
  const tmpV = new THREE.Vector3();

  // --- setup ---------------------------------------------------------------
  view.reset();
  monsterView.setVisible(!menu);
  if (menu) {
    world.setPowerGain(0.92);
    monster.relocate(9999, 9999);
  } else {
    world.setPowerGain(STAGE_POWER[0]);
  }
  audio.startSession();
  if (!menu) {
    audio.setLocator("panel", { x: ot.panel.x, y: 1.4, z: ot.panel.z }, true, "buzz");
    audio.setLocator("tv", { x: ot.tv.x, y: 0.6, z: ot.tv.z }, true, "static");
  }

  // --- helpers -------------------------------------------------------------
  const later = (delay, fn) => pending.push({ at: time + delay, fn });

  function relDir(x, z) {
    const f = spots.forwardOf(player.yaw);
    const dx = x - player.pos.x;
    const dz = z - player.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const fwd = (dx * f.x + dz * f.z) / len;
    const right = (dx * -f.z + dz * f.x) / len;
    if (fwd > 0.7) return "à frente";
    if (fwd < -0.7) return "atrás";
    return right > 0 ? "à direita" : "à esquerda";
  }

  function subtitle(text, pos) {
    if (!settings.subtitles) return;
    ui.subtitle(pos ? `[${text} — ${relDir(pos.x, pos.z)}]` : `[${text}]`);
  }

  const playerInfo = () => ({ x: player.pos.x, z: player.pos.z, yaw: player.yaw });

  function canSeeMonster() {
    const mp = monster.pos;
    const p = playerInfo();
    if (!spots.canPlayerSee(collision, p, mp.x, mp.z, 0.5)) return false;
    const dist = Math.hypot(mp.x - p.x, mp.z - p.z);
    if (lightField.sample(mp.x, mp.z) > 0.12) return dist < 40;
    // Dark: only the flashlight cone reveals it.
    return view.on && dist < 22 && spots.inViewCone(p, mp.x, mp.z, 0.88);
  }

  function setStage(s) {
    stage = s;
    monster.setStage(s);
    director.setStage(s);
    world.setPowerGain(STAGE_POWER[s]);
  }

  // --- objectives ------------------------------------------------------------
  // silent: re-applies the world changes without feedback (checkpoint restore).
  function onObjective(id, silent = false) {
    director.progressMade();
    const next = STEPS[objectives.step];
    const fx = !silent;
    if (id === "power") {
      setStage(1);
      world.setPanelPowered();
      audio.setLocator("panel", null, false);
      // Dark sectors partially come back, flickering.
      map.lamps.forEach((l, i) => {
        if (l.zone !== ZONE.DARK || world.lampState[i] !== LAMP.OFF) return;
        const roll = rng.next();
        if (roll < 0.25) world.setLamp(i, LAMP.ON);
        else if (roll < 0.7) world.setLamp(i, LAMP.FLICKER);
      });
      if (fx) {
        audio.panelClunk({ x: ot.panel.x, y: 1.4, z: ot.panel.z });
        audio.powerSurge();
        world.lampSequence(world.lampsNear(player.pos.x, player.pos.z, 30).map((l) => l.i), { interval: 0.05, level: 0.02, hold: 0.9 });
        world.dipPower(0.8);
        ui.message("A energia voltou.", 3);
        subtitle("a energia volta com um estalo");
        later(4, () => {
          audio.screech({ x: monster.pos.x, y: 1.5, z: monster.pos.z }, { distant: true });
          subtitle("um grito distante", monster.pos);
        });
      }
    } else if (id === "tape") {
      setStage(2);
      world.takeTape();
      audio.setLocator("tv", null, false);
      world.setExitPowered(true);
      // Parts of the map lose power for good.
      map.lamps.forEach((l, i) => {
        const c = world.lampPositions[i];
        const far = Math.hypot(c.x - player.pos.x, c.z - player.pos.z) > 18;
        if (far && world.lampState[i] === LAMP.ON && rng.chance(0.22)) world.setLamp(i, LAMP.OFF);
      });
      if (fx) {
        audio.tapeTaken({ x: ot.tape.x, y: 0.3, z: ot.tape.z });
        glitch = 1.6;
        audio.glitch();
        noises.push({ type: "tape", x: ot.tape.x, z: ot.tape.z, radius: 26 });
        ui.message("Na fita: uma porta de metal sob uma luz vermelha.", 5);
        later(2.5, () => subtitle("um bipe distante", ot.door));
      }
    } else if (id === "exit") {
      setStage(3);
      world.setAlarm(true);
      monster.setHotspot({ x: d.x, z: d.z });
      audio.setLocator("door", { x: d.x, y: 1.2, z: d.z }, true, "grind");
      noises.push({ type: "door", x: d.x, z: d.z, radius: 45 });
      if (fx) {
        ui.message("A porta está cedendo. Ela vai ouvir.", 4);
        subtitle("alarme");
      }
    } else if (id === "escape") {
      setStage(4);
      world.setAlarm(false);
      world.setDoorProgress(1);
      audio.setLocator("door", null, false);
      audio.doorOpened({ x: d.x, y: 1.2, z: d.z });
      ui.message("Aberta.", 2.5);
      subtitle("a porta se abre");
    }
    if (next) ui.setObjective(next.text);
  }

  // Checkpoint restore: replay completed objectives silently and wake up next to the last one.
  function restoreCheckpoint(count) {
    const ids = ["power", "tape", "exit"].slice(0, count);
    const tvFront = { x: ot.tv.x + ot.tv.normal.x * 1.4, z: ot.tv.z + ot.tv.normal.z * 1.4, normal: ot.tv.normal };
    const panelFront = { x: ot.panel.x + ot.panel.normal.x * 1.2, z: ot.panel.z + ot.panel.normal.z * 1.2, normal: ot.panel.normal };
    const doorFront = { x: d.x + d.normal.x * 1.4, z: d.z + d.normal.z * 1.4, normal: d.normal };
    const at = [panelFront, tvFront, doorFront][count - 1];
    player.teleport(at.x, at.z);
    player.yaw = Math.atan2(-at.normal.x, -at.normal.z);
    for (const id of ids) {
      objectives.skipTo(objectives.step + 1);
      onObjective(id, true);
    }
    graceUntil = 8;
    relocateFar(14);
  }

  // --- director events ---------------------------------------------------------
  function runEvent(name) {
    const p = playerInfo();
    switch (name) {
      case "humCut":
        humCut = 3.5;
        world.dipPower(0.35);
        later(3.5, () => {
          const near = world.lampsNear(p.x, p.z, 10)[0];
          if (near) audio.lampPop({ x: world.lampPositions[near.i].x, y: 2.8, z: world.lampPositions[near.i].z }, 0.5);
        });
        return true;
      case "lightOutBehind": {
        const li = spots.findLampBehind(map, p, world.isLampLit, rng);
        if (li < 0) return false;
        world.setLamp(li, LAMP.OFF);
        const lp = world.lampPositions[li];
        audio.lampPop({ x: lp.x, y: 2.8, z: lp.z });
        subtitle("uma lâmpada estoura", lp);
        return true;
      }
      case "distantKnock": {
        const pt = spots.findHiddenPoint(map, collision, p, rng, 5, 11);
        if (!pt) return false;
        audio.knock({ x: pt.x, y: 1.3, z: pt.z });
        subtitle("batidas do outro lado da parede", pt);
        return true;
      }
      case "metalGroan": {
        const pt = spots.findHiddenPoint(map, collision, p, rng, 10, 22);
        if (!pt) return false;
        audio.metalGroan({ x: pt.x, y: 2.5, z: pt.z });
        subtitle("metal rangendo", pt);
        return true;
      }
      case "lampPop": {
        const near = world.lampsNear(p.x, p.z, 11).filter((l) => l.d > 4 && world.isLampLit(l.i));
        if (!near.length) return false;
        const li = rng.pick(near).i;
        world.lampSequence([li], { level: 0.02, hold: 1.8 });
        const lp = world.lampPositions[li];
        audio.lampPop({ x: lp.x, y: 2.8, z: lp.z }, 0.7);
        subtitle("estalo elétrico", lp);
        return true;
      }
      case "flickerWave": {
        const f = spots.forwardOf(p.yaw);
        const list = world
          .lampsNear(p.x, p.z, 24)
          .map((l) => ({ ...l, along: (world.lampPositions[l.i].x - p.x) * f.x + (world.lampPositions[l.i].z - p.z) * f.z }))
          .filter((l) => l.along > -2)
          .sort((a, b) => b.along - a.along)
          .map((l) => l.i);
        return world.lampSequence(list, { interval: 0.09, level: 0.06, hold: 0.3 });
      }
      case "phantomSteps": {
        const f = spots.forwardOf(p.yaw);
        const base = { x: p.x - f.x * 7, z: p.z - f.z * 7 };
        if (!collision.segmentClear(p.x, p.z, base.x, base.z)) return false;
        for (let k = 0; k < 4; k++) {
          later(k * 0.58, () => {
            const pos = { x: base.x + f.x * k * 0.7, y: 0.1, z: base.z + f.z * k * 0.7 };
            if (spots.inViewCone(playerInfo(), pos.x, pos.z, 0.3)) return;
            audio.phantomStep(pos);
          });
        }
        subtitle("passos atrás de você");
        return true;
      }
      case "distantVoice": {
        const dist = Math.hypot(monster.pos.x - p.x, monster.pos.z - p.z);
        if (dist < 18) return false;
        audio.screech({ x: monster.pos.x, y: 1.5, z: monster.pos.z }, { distant: true });
        subtitle("um grito distante", monster.pos);
        return true;
      }
      case "objectMoved": {
        const options = world.chairProps().filter((c) => {
          const cc = cellCenter(g, c.x, c.y);
          const dist = Math.hypot(cc.x - p.x, cc.z - p.z);
          return dist > 7 && dist < 22 && !spots.canPlayerSee(collision, p, cc.x, cc.z, 0.2);
        });
        if (!options.length) return false;
        return world.moveChair(rng.pick(options), rng);
      }
      case "vhsGlitch":
        glitch = 1.2;
        audio.glitch();
        return true;
      case "newDoor": {
        const slot = spots.findNewDoorSlot(map, collision, p, rng, world.usedWallSlots());
        return slot ? world.addDoor(slot) : false;
      }
      default:
        return false;
    }
  }

  function runStalk() {
    if (stage >= 3 || !monster.isCalm()) return false;
    const p = playerInfo();
    if (rng.chance(0.5)) {
      const cross = spots.findCrossing(map, collision, p, rng);
      if (cross && spots.isSafeTeleport(collision, p, cross.from.x, cross.from.z, 12)) {
        monster.crossAt(cross.from, cross.to);
        stalkSeen = false;
        return true;
      }
    }
    const spot = spots.findStalkSpot(map, collision, p, rng);
    if (!spot || !spots.isSafeTeleport(collision, p, spot.x, spot.z)) return false;
    monster.stalkAt(spot, { x: p.x, z: p.z });
    stalkSeen = false;
    return true;
  }

  function relocateFar(minCells) {
    const spot = spots.findFarRelocation(map, collision, playerInfo(), rng, minCells);
    if (spot) monster.relocate(spot.x, spot.z);
    return !!spot;
  }

  // --- end sequences -----------------------------------------------------------
  function startDeath() {
    phase = "dying";
    sequenceT = 0;
    monsterView.headPosition(tmpV);
    deathYaw = Math.atan2(-(tmpV.x - player.pos.x), -(tmpV.z - player.pos.z));
    deathPitch = Math.atan2(tmpV.y - player.eyeHeight(), Math.hypot(tmpV.x - player.pos.x, tmpV.z - player.pos.z));
    view.addTrauma(1);
    audio.death();
    flash = 0.75;
    glitch = 2;
  }

  function startWin() {
    phase = "winning";
    sequenceT = 0;
    monsterView.setVisible(false);
    audio.setMonster(monster.pos, 0, 0);
  }

  // --- simulation ------------------------------------------------------------
  function readInput(input) {
    if (inputOverride) return inputOverride();
    const kd = input.isDown;
    return {
      forward: (kd("KeyW") || kd("ArrowUp") ? 1 : 0) - (kd("KeyS") || kd("ArrowDown") ? 1 : 0),
      right: (kd("KeyD") || kd("ArrowRight") ? 1 : 0) - (kd("KeyA") || kd("ArrowLeft") ? 1 : 0),
      sprint: kd("ShiftLeft") || kd("ShiftRight"),
      crouch: kd("KeyC") || kd("ControlLeft"),
      interactHeld: kd(INTERACT),
    };
  }

  function step(dt, input) {
    // Edge presses are consumed every step so stale presses never fire later.
    const interactPressed = input.consumePress(INTERACT);
    const flashPressed = input.consumePress("KeyF");

    for (let k = pending.length - 1; k >= 0; k--) {
      if (pending[k].at <= time) {
        const fn = pending[k].fn;
        pending.splice(k, 1);
        fn();
      }
    }

    if (phase === "menu") {
      time += dt;
      return;
    }
    if (phase === "intro") return;
    if (phase === "wake") {
      wake += dt;
      time += dt;
      if (wake >= 3.2) phase = "play";
      return;
    }
    if (phase === "dying" || phase === "winning") {
      sequenceT += dt;
      if (phase === "dying") {
        monster.update(dt, DYING_CTX);
        if (sequenceT > 2.6 && !result) result = { type: "dead" };
      } else {
        // Walk into the light.
        const k = dt * 0.9 * Math.max(0, 1 - sequenceT / 3);
        player.pos.x -= d.normal.x * k;
        player.pos.z -= d.normal.z * k;
        player.prev.x = player.pos.x;
        player.prev.z = player.pos.z;
        if (sequenceT > 4.5 && !result) result = { type: "win" };
      }
      return;
    }

    // --- play ---
    time += dt;
    const inp = readInput(input);
    const events = [];
    const ps = player.step(dt, inp, events);
    for (const e of events) {
      audio.footstep(e.gait);
      noises.push({ type: "step", x: e.x, z: e.z, radius: e.radius });
    }
    if (flashPressed) {
      view.toggle();
      audio.flashlightClick();
      noises.push({ type: "click", x: player.pos.x, z: player.pos.z, radius: 3 });
    }

    // Objectives & interaction.
    const fwd = spots.forwardOf(player.yaw);
    const res = objectives.update(dt, { x: player.pos.x, z: player.pos.z, fx: fwd.x, fz: fwd.z }, { pressed: interactPressed, held: inp.interactHeld });
    ui.setPrompt(res.prompt, res.progress && objectives.current.hold ? res.progress : 0);
    if (res.message) {
      ui.message(res.message, 2.5);
      audio.doorLocked({ x: d.x, y: 1.2, z: d.z });
    }
    // Working the panel/door is loud, but only while E is actually held on it.
    if (inp.interactHeld && res.prompt && objectives.current.hold) {
      holdNoiseT -= dt;
      if (holdNoiseT <= 0) {
        holdNoiseT = 0.9;
        const target = objectives.current.id === "power" ? ot.panel : exitFront;
        noises.push({ type: "work", x: target.x, z: target.z, radius: 10 });
        audio.doorLocked({ x: target.x, y: 1.3, z: target.z });
      }
    }
    if (res.completed) onObjective(res.completed);
    if (objectives.current.id === "escape") {
      const remaining = Math.ceil(STEPS[3].duration * (1 - res.progress));
      ui.setObjective(`A porta está abrindo... ${remaining}`, 2);
      world.setDoorProgress(res.progress * 0.3);
    }

    // Batteries.
    for (let k = 0; k < world.batteries.length; k++) {
      const b = world.batteries[k];
      if (b.taken || Math.hypot(b.x - player.pos.x, b.z - player.pos.z) > 0.95) continue;
      world.takeBattery(k);
      view.addBattery(FLASHLIGHT.batteryPickup);
      audio.pickup();
      ui.message("+ pilhas", 1.6);
    }

    // Creature.
    const playerSees = canSeeMonster();
    const camF = view.getForward(tmpV);
    const camLen = Math.hypot(camF.x, camF.z) || 1;
    monster.update(dt, {
      player: {
        x: player.pos.x,
        z: player.pos.z,
        vx: player.vel.x,
        vz: player.vel.z,
        crouch: player.crouch,
        flashlightOn: view.on && view.battery > 0,
        dirX: camF.x / camLen,
        dirZ: camF.z / camLen,
      },
      noises,
      grace: time < graceUntil,
      playerSeesMonster: playerSees,
      godMode,
    });
    noises.length = 0;
    for (const e of monster.drainEvents()) handleMonsterEvent(e, playerSees);
    if (phase !== "play") return;

    // Keep a presence: if it drifted very far for a long time, bring it back (out of sight, far).
    const mDist = Math.hypot(monster.pos.x - player.pos.x, monster.pos.z - player.pos.z);
    if (stage >= 1 && mDist > 55 && monster.isCalm()) {
      presenceT += dt;
      if (presenceT > 75) {
        presenceT = 0;
        relocateFar(10);
      }
    } else presenceT = 0;

    // Director.
    const actions = director.update(dt, {
      monsterDist: mDist,
      hunting: monster.isHunting(),
      searching: monster.state === S.SEARCH || monster.state === S.INVESTIGATE,
      playerDark: lightField.sample(player.pos.x, player.pos.z) < 0.15,
      playerMoving: !!ps.moving,
      monsterCalm: monster.isCalm(),
    });
    for (const a of actions) {
      if (a.type === "event") director.report(a.name, runEvent(a.name));
      else if (a.type === "stalk") director.report("stalk", runStalk());
      else if (a.type === "hint") giveHint();
    }

    // Exit trigger: inside the light chamber.
    if (objectives.current.id === "leave") {
      const lz = (player.pos.x - d.x) * d.normal.x + (player.pos.z - d.z) * d.normal.z;
      if (lz < -0.9) startWin();
    }
  }

  function handleMonsterEvent(e, playerSees) {
    const mp = monster.pos;
    switch (e.type) {
      case "caught":
        if (phase === "play") startDeath();
        break;
      case "screech":
        audio.screech({ x: mp.x, y: 1.6, z: mp.z });
        subtitle("um guincho", mp);
        if (time - chaseStingerAt > 90 && playerSees) {
          chaseStingerAt = time;
          audio.stinger();
          view.addTrauma(0.35);
          glitch = Math.max(glitch, 0.6);
        }
        break;
      case "vanish":
        // Early-stage contact: lights die for a moment and it is gone.
        world.lampSequence(world.lampsNear(player.pos.x, player.pos.z, 14).map((l) => l.i), { interval: 0, level: 0.01, hold: 1.2 });
        world.dipPower(0.9);
        audio.screech({ x: mp.x, y: 1.6, z: mp.z });
        audio.stinger();
        view.addTrauma(0.5);
        glitch = 1.5;
        later(0.4, () => relocateFar(14));
        director.peak();
        break;
      case "step": {
        const dist = Math.hypot(e.x - player.pos.x, e.z - player.pos.z);
        if (dist < 30) audio.creatureStep({ x: e.x, y: 0.1, z: e.z }, e.speed);
        break;
      }
      case "stalkEnd":
        if (e.seen && monster.state === S.COOLDOWN) later(6, () => monster.isCalm() && !canSeeMonster() && relocateFar(12));
        break;
      default:
        break;
    }
  }

  function giveHint() {
    const id = objectives.current.id;
    if (id === "power") {
      audio.boostLocator("panel", 2.2);
      subtitle("zumbido elétrico", ot.panel);
    } else if (id === "tape") {
      audio.boostLocator("tv", 2.2);
      subtitle("estática de TV", ot.tv);
    } else if (id === "exit") {
      subtitle("bipe da porta", d);
    }
  }

  // --- presentation ---------------------------------------------------------
  function frame(dt, alpha, mouse, sensitivity, extra) {
    const playing = phase === "play";
    if (playing && mouse) {
      player.yaw -= mouse.dx * sensitivity;
      player.pitch = player.pitch - mouse.dy * sensitivity;
    }
    if (phase === "menu") {
      player.yaw += dt * 0.035;
      player.pitch = Math.sin(time * 0.1) * 0.05 + 0.03;
    }

    let override = null;
    let handDrop = menu ? 1 : 0;
    let eye = player.eyeHeight();
    if (phase === "intro" || phase === "wake") {
      const t = Math.min(1, wake / 3.2);
      const e = t * t * (3 - 2 * t);
      eye = 0.32 + (eye - 0.32) * e;
      const reduce = settings.reduceMotion ? 0 : 1;
      override = { yaw: player.yaw + (1 - e) * 0.4 * reduce, pitch: (1 - e) * 1.15, roll: (1 - e) * 0.35 * reduce };
      ui.setFade(Math.max(0, 1 - wake / 2));
      handDrop = 1 - Math.min(1, Math.max(0, (wake - 1.8) / 1.2));
    } else if (phase === "dying") {
      const k = Math.min(1, sequenceT / 0.25);
      let dy = deathYaw - player.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      override = { yaw: player.yaw + dy * k, pitch: player.pitch + (deathPitch - player.pitch) * k, roll: 0 };
      if (sequenceT > 1.4) ui.setFade(Math.min(1, (sequenceT - 1.4) / 0.7));
      ui.setHudVisible(false);
    } else if (phase === "winning") {
      exposure = 1 + Math.min(4, sequenceT * 1.6);
      ui.setFadeColor("#fffdf4");
      ui.setFade(Math.min(1, Math.max(0, (sequenceT - 1.2) / 2.2)));
      ui.setHudVisible(false);
      handDrop = Math.min(1, sequenceT / 1.5);
    }

    const mDist = Math.hypot(monster.pos.x - player.pos.x, monster.pos.z - player.pos.z);
    view.update({
      dt,
      x: player.pos.x,
      z: player.pos.z,
      prevX: player.prev.x,
      prevZ: player.prev.z,
      alpha: phase === "play" ? alpha : 1,
      eye,
      yaw: player.yaw,
      pitch: player.pitch,
      state: phase === "play" ? player.state : null,
      stridePhase: player.stridePhase,
      crouchAmount: player.crouch,
      time,
      settings,
      mouseDx: playing && mouse ? mouse.dx : 0,
      mouseDy: playing && mouse ? mouse.dy : 0,
      drainBattery: playing,
      monsterDist: stage >= 1 ? mDist : 99,
      override,
      handDrop,
    });
    monsterView.update(dt, monster, phase === "play" ? alpha : 1, time);
    world.update(dt, player.pos);

    // Audio.
    camera.getWorldPosition(tmpV);
    const listenerPos = { x: tmpV.x, y: tmpV.y, z: tmpV.z };
    camera.getWorldDirection(tmpV);
    audio.setListener(listenerPos, tmpV);
    humCut = Math.max(0, humCut - dt);
    const hunting = monster.isHunting();
    const tension = menu ? 0.05 : director.tension;
    const st = player.state;
    audio.update(dt, {
      tension,
      chase: hunting && mDist < 30 ? 1 : 0,
      exertion: st ? st.stamina.exertion : 0,
      stress: hunting ? 1 : Math.max(0, (tension - 0.5) * 1.6),
      power: phase === "winning" ? 0 : STAGE_POWER[stage] * (menu ? 0.8 : 1),
      humCut: humCut > 0 ? 1 : 0,
      beacon: stage >= 2 && phase === "play",
      alarm: stage === 3,
      exitPos: { x: d.x, y: 2.6, z: d.z },
      outside: phase === "winning" ? Math.min(1, sequenceT / 2) : stage >= 4 && mDist >= 0 ? 0.15 : 0,
    });
    if (!menu) {
      const level = CREATURE_VOICE[monster.state];
      const occluded = !collision.segmentClear(player.pos.x, player.pos.z, monster.pos.x, monster.pos.z);
      audio.setMonster(monster.pos, phase === "winning" ? 0 : level * (occluded ? 0.55 : 1), hunting ? 1 : 0.2);
    }
    buzzT -= dt;
    if (buzzT <= 0) {
      buzzT = 0.4;
      const lit = world.lampsNear(player.pos.x, player.pos.z, 9).filter((l) => world.lampState[l.i] !== LAMP.OFF);
      audio.setLampBuzz(lit.slice(0, 2).map((l) => world.lampPositions[l.i]));
    }
    for (const tick of world.drainLampTicks()) audio.lampTick({ x: tick.x, y: 2.8, z: tick.z });

    // Post.
    glitch = Math.max(0, glitch - dt);
    flash = Math.max(0, flash - dt * 0.6);
    if (stage >= 1 && playing && monster.state === S.STALK && canSeeMonster() && !stalkSeen) {
      stalkSeen = true;
      audio.stinger();
      glitch = 0.5;
      director.peak();
    }
    extra.effects.set({
      stress: menu ? 0 : Math.min(1, tension * 0.9 + (hunting ? 0.2 : 0)),
      tracking: Math.min(1, glitch),
      flash,
      exposure,
      chromaBoost: phase === "dying" ? 1 : hunting && mDist < 8 ? 0.25 : 0,
    });

    if (!menu) {
      ui.setOsdTime(timeOffset + time);
      const stam = st ? st.stamina.value : 100;
      ui.setMeters(stam, playing && stam < 99, view.battery, playing && (view.on || view.battery < 30));
    }
  }

  if (!menu && opts.checkpoint > 0) restoreCheckpoint(Math.min(3, opts.checkpoint));

  return {
    map,
    world,
    player,
    monster,
    director,
    objectives,
    collision,
    lightField,
    step,
    frame,
    beginWake() {
      phase = "wake";
      wake = 0;
      ui.setObjective(objectives.current.text, 9);
      ui.setControlsHint("[F] lanterna   [Shift] correr   [C] agachar   [E] interagir", 10);
    },
    get phase() {
      return phase;
    },
    get stage() {
      return stage;
    },
    get time() {
      return time;
    },
    get result() {
      return result;
    },
    get seed() {
      return map.seed;
    },
    canPause: () => phase === "play" || phase === "wake",
    currentObjectiveText: () => objectives.current.text,
    stats: () => ({ time: timeOffset + time, attemptTime: time, objectives: objectives.completedCount, seed: map.seed, stage }),
    // --- debug / QA ---
    completeObjective() {
      const id = objectives.current.id;
      if (id === "leave") return;
      objectives.skipTo(objectives.step + 1);
      onObjective(id);
    },
    debugKill() {
      if (phase === "play") startDeath();
    },
    endGrace() {
      graceUntil = 0;
    },
    setGodMode(v) {
      godMode = v;
    },
    setInputOverride(fn) {
      inputOverride = fn;
    },
    objectiveTarget() {
      const id = objectives.current.id;
      if (id === "power") return ot.panel;
      if (id === "tape") return ot.tape;
      if (id === "exit") return exitFront;
      if (id === "leave") return { x: d.x - d.normal.x * 2.6, z: d.z - d.normal.z * 2.6 };
      return null;
    },
    pathTo(x, z) {
      const a = worldToCell(g, player.pos.x, player.pos.z);
      const b = worldToCell(g, x, z);
      return findPath(g, a.y * g.w + a.x, b.y * g.w + b.x);
    },
    debugInfo() {
      return {
        seed: map.seed,
        attempts: map.attempts,
        phase,
        stage,
        time,
        tension: director.tension,
        director: director.debug(),
        objective: objectives.current.id,
        player: { x: player.pos.x, z: player.pos.z, cell: worldToCell(g, player.pos.x, player.pos.z) },
        monster: { state: monster.state, x: monster.pos.x, z: monster.pos.z, awareness: monster.m.awareness, sees: monster.m.seesPlayer },
        battery: view.battery,
      };
    },
    dispose() {
      pending = [];
      audio.endSession();
      world.dispose();
      monsterView.dispose();
      lamp.unbind();
    },
  };
}
