import * as THREE from "three";
import { cellCenter } from "../game/grid.js";
import { S } from "../game/monster.js";

// Development-only overlay and QA hooks (never bundled in production: loaded via
// a dynamic import behind import.meta.env.DEV).
//   F3 overlay · F4 jump to current objective · F6 god mode · F7 creature nearby
//   F8 autopilot (walks to objectives through the real collision)
// window.__game exposes the same controls for automated browser QA.

export function createDebug(ctx) {
  const panel = document.createElement("pre");
  panel.style.cssText =
    "position:fixed;top:8px;left:8px;z-index:50;margin:0;padding:8px 10px;background:rgba(0,0,0,.72);color:#9f9;font:11px/1.35 monospace;pointer-events:none;white-space:pre;display:none";
  document.body.append(panel);
  const pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff3030, depthTest: false }));
  pathLine.renderOrder = 10;
  pathLine.frustumCulled = false;
  ctx.scene.add(pathLine);

  let visible = new URLSearchParams(location.search).has("debug");
  let god = false;
  let autopilot = false;
  let fpsT = 0;
  let frames = 0;
  let fps = 0;
  let worst = 0;
  let stuckT = 0;
  let pressToggle = false;
  let lastPos = null;
  const log = [];

  function autopilotInput() {
    const s = ctx.session;
    const target = s.objectiveTarget();
    const p = s.player.pos;
    const out = { forward: 0, right: 0, sprint: false, crouch: false, interactHeld: false };
    if (!target) return out;
    const dist = Math.hypot(target.x - p.x, target.z - p.z);
    let aim = target;
    if (dist > 1.2) {
      const path = s.pathTo(target.x, target.z);
      if (path && path.length > 2) aim = cellCenter(s.map.grid, path[1] % s.map.grid.w, (path[1] / s.map.grid.w) | 0);
      if (path && path.length > 2 && s.collision.corridorClear(p.x, p.z, cellCenter(s.map.grid, path[2] % s.map.grid.w, (path[2] / s.map.grid.w) | 0).x, cellCenter(s.map.grid, path[2] % s.map.grid.w, (path[2] / s.map.grid.w) | 0).z, 0.32)) {
        aim = cellCenter(s.map.grid, path[2] % s.map.grid.w, (path[2] / s.map.grid.w) | 0);
      }
      if (!path || path.length <= 2) aim = target;
    }
    s.player.yaw = Math.atan2(-(aim.x - p.x), -(aim.z - p.z));
    s.player.pitch = 0;
    if (dist > 0.9) out.forward = 1;
    out.interactHeld = dist < 1.6;
    // Tap E repeatedly for instant interactions (a single press may land before facing the target).
    pressToggle = !pressToggle;
    ctx.input.setKey("KeyE", out.interactHeld && s.objectives.current.hold === 0 && pressToggle);
    return out;
  }

  function setAutopilot(on) {
    autopilot = on;
    ctx.session?.setInputOverride(on ? autopilotInput : null);
  }

  function jumpToObjective() {
    const s = ctx.session;
    const t = s?.objectiveTarget();
    if (!t) return;
    s.player.teleport(t.x, t.z);
  }

  window.addEventListener("keydown", (e) => {
    if (e.code === "F3") {
      visible = !visible;
      e.preventDefault();
    } else if (e.code === "F4") jumpToObjective();
    else if (e.code === "F6") {
      god = !god;
      ctx.session?.setGodMode(god);
    } else if (e.code === "F7") {
      const s = ctx.session;
      const f = { x: -Math.sin(s.player.yaw), z: -Math.cos(s.player.yaw) };
      s.monster.relocate(s.player.pos.x + f.x * 6, s.player.pos.z + f.z * 6);
    } else if (e.code === "F8") setAutopilot(!autopilot);
  });

  const api = {
    get state() {
      return ctx.state;
    },
    info: () => ctx.session?.debugInfo(),
    renderInfo: () => ({ ...ctx.renderer.info.render, ...ctx.renderer.info.memory, programs: ctx.renderer.info.programs?.length }),
    memory: () => (performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null),
    fps: () => ({ fps, worstMs: worst }),
    start: (seed) => ctx.startRun(seed),
    skipIntro: () => ctx.finishIntro(),
    menu: () => ctx.enterMenu(),
    pause: () => ctx.pause(),
    resume: () => ctx.resume(),
    virtualLock: (on) => ctx.input.setVirtualLock(on),
    key: (code, on) => ctx.input.setKey(code, on),
    look: (yaw, pitch = 0) => {
      ctx.session.player.yaw = yaw;
      ctx.session.player.pitch = pitch;
    },
    teleport: (x, z) => ctx.session.player.teleport(x, z),
    jumpToObjective,
    god: (on) => ((god = on), ctx.session?.setGodMode(on)),
    autopilot: setAutopilot,
    quality: (name) => ctx.applyPreset(name),
    timeScale: (n) => (ctx.dev.timeScale = Math.max(1, Math.min(8, n))),
    monsterNear: () => {
      const s = ctx.session;
      s.endGrace();
      const f = { x: -Math.sin(s.player.yaw), z: -Math.cos(s.player.yaw) };
      s.monster.relocate(s.player.pos.x + f.x * 6, s.player.pos.z + f.z * 6);
      s.monster.m.yaw = Math.atan2(s.player.pos.x - s.monster.pos.x, s.player.pos.z - s.monster.pos.z);
      s.monster.m.state = S.IDLE;
      s.monster.m.pause = 3;
    },
    setStage: (n) => {
      const s = ctx.session;
      for (let guard = 0; s.stage < n && guard < 5; guard++) s.completeObjective();
    },
    // Places the camera in front of a named landmark looking at it (for screenshots).
    viewpoint(name, distance = 2.2) {
      const s = ctx.session;
      const o = s.world.objectives;
      let target;
      if (name === "hall" && s.map.halls.length) {
        const h = s.map.halls[0];
        const c = cellCenter(s.map.grid, h.x + 0.5, h.y + 0.5);
        const far = cellCenter(s.map.grid, h.x + h.rw - 1, h.y + h.rh - 1);
        s.player.teleport(c.x - 1.5, c.z - 1.5);
        s.player.yaw = Math.atan2(-(far.x - c.x), -(far.z - c.z));
        s.player.pitch = 0;
        return true;
      }
      target = o[name];
      if (!target) return false;
      const n = target.normal || o.tv.normal;
      s.player.teleport(target.x + n.x * distance, target.z + n.z * distance);
      s.player.yaw = Math.atan2(n.x, n.z);
      s.player.pitch = name === "panel" ? 0.05 : name === "door" ? 0.12 : -0.3;
      return true;
    },
    flashlight: (on) => {
      const v = ctx.session && ctx.session;
      if (!v) return;
      ctx.input.setKey("KeyF", true);
      setTimeout(() => ctx.input.setKey("KeyF", false), 50);
    },
    log,
  };
  window.__game = api;

  return {
    update(dt) {
      frames++;
      fpsT += dt;
      worst = Math.max(worst, dt * 1000);
      if (fpsT >= 1) {
        fps = Math.round(frames / fpsT);
        frames = 0;
        fpsT = 0;
        if (!visible) worst = 0;
      }
      const s = ctx.session;
      if (autopilot && s && s.phase === "play") {
        const p = s.player.pos;
        if (lastPos && Math.hypot(p.x - lastPos.x, p.z - lastPos.z) < 0.02) stuckT += dt;
        else stuckT = 0;
        lastPos = { x: p.x, z: p.z };
        if (stuckT > 3) {
          log.push({ t: s.time, msg: "autopilot stuck", x: p.x, z: p.z, objective: s.objectives.current.id });
          stuckT = 0;
        }
      }
      if (!visible || !s) {
        panel.style.display = "none";
        pathLine.visible = false;
        return;
      }
      panel.style.display = "block";
      const i = s.debugInfo();
      const r = ctx.renderer.info;
      panel.textContent = [
        `FPS ${fps}  worst ${worst.toFixed(1)}ms  state ${ctx.state}/${i.phase}`,
        `draws ${r.render.calls}  tris ${r.render.triangles}  geo ${r.memory.geometries}  tex ${r.memory.textures}  prog ${r.programs?.length}`,
        `seed ${i.seed} (attempts ${i.attempts})  stage ${i.stage}  objective ${i.objective}`,
        `player ${i.player.x.toFixed(1)}, ${i.player.z.toFixed(1)}  cell ${i.player.cell.x},${i.player.cell.y}  battery ${i.battery.toFixed(0)}`,
        `creature ${i.monster.state}  aware ${i.monster.awareness.toFixed(2)}  sees ${i.monster.sees}  at ${i.monster.x.toFixed(1)}, ${i.monster.z.toFixed(1)}`,
        `tension ${i.tension.toFixed(2)}  next event ${i.director.nextEventIn.toFixed(0)}s  stalk ${Number.isFinite(i.director.nextStalkIn) ? i.director.nextStalkIn.toFixed(0) + "s" : "-"}  relief ${i.director.relief.toFixed(0)}s`,
        `god ${god}  autopilot ${autopilot}   [F4 objective F6 god F7 creature F8 autopilot]`,
      ].join("\n");
      const pts = s.monster.debugPath().map((p) => new THREE.Vector3(p.x, 0.15, p.z));
      pts.unshift(new THREE.Vector3(s.monster.pos.x, 0.15, s.monster.pos.z));
      pathLine.geometry.dispose();
      pathLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      pathLine.visible = pts.length > 1;
    },
  };
}
