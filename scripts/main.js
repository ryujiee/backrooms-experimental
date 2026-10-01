import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
import * as THREE from "three";
import { loadSettings, saveSettings, loadStats, saveStats, sensitivityToRadians } from "./core/settings.js";
import { randomSeedLabel } from "./core/rng.js";
import { loadAssets } from "./core/assets.js";
import { log } from "./core/log.js";
import { createUI, formatTime } from "./systems/ui.js";
import { createAudio } from "./systems/audio.js";
import { createInput } from "./systems/input.js";
import { createTextures } from "./systems/textures.js";
import { createLamp } from "./systems/lampShader.js";
import { createEffects } from "./systems/effects.js";
import { createPlayerView } from "./systems/view.js";
import { createSession } from "./systems/session.js";
import { createWorldMaterials } from "./systems/world.js";
import { PRESETS, resolvePreset, createFrameMonitor } from "./systems/quality.js";

// Game states: LOADING -> MENU -> INTRO -> PLAYING <-> PAUSED -> DEAD | WIN.
// Listeners are registered once here; each run is a disposable Session.

const STEP = 1 / 60;
const MAX_STEPS = 5;
const FOG_COLOR = 0x14120b;
const INTRO_LINES = [
  { at: 0.2, text: "▶ PLAY", small: true },
  { at: 0.9, text: "FITA 03 — GRAVAÇÃO RECUPERADA", small: true },
  { at: 2.2, text: "Você não se lembra de ter entrado aqui." },
  { at: 4.0, text: "O zumbido não para." },
  { at: 5.7, text: "Alguma coisa também acordou." },
];
const INTRO_LENGTH = 8.2;
const REWIND_LINES = [{ at: 0.1, text: "◀◀ REBOBINANDO", small: true }];
const REWIND_LENGTH = 2.2;

const ui = createUI();

function isTouchOnly() {
  const coarse = window.matchMedia?.("(pointer: coarse)").matches;
  const fine = window.matchMedia?.("(pointer: fine)").matches;
  return (coarse && !fine) || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!c.getContext("webgl2");
  } catch {
    return false;
  }
}

async function boot() {
  if (isTouchOnly()) {
    ui.show("mobile");
    return;
  }
  if (!webglAvailable()) {
    ui.showError("Seu navegador não oferece WebGL 2, que é necessário para o jogo.");
    return;
  }

  const canvas = document.getElementById("game");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Post-processing renders several passes per frame; count them all together.
  renderer.info.autoReset = false;

  const settings = loadSettings();
  const stats = loadStats();
  let preset = resolvePreset(settings.quality, renderer);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(FOG_COLOR);
  scene.fog = new THREE.FogExp2(FOG_COLOR, preset.fog);
  const camera = new THREE.PerspectiveCamera(settings.fov, window.innerWidth / window.innerHeight, 0.05, preset.far);

  const textures = createTextures(preset.name);
  const lamp = createLamp(textures.macro);
  const materials = createWorldMaterials(textures, lamp);
  const audio = createAudio();
  audio.setVolumes(settings);
  const input = createInput(canvas);
  const effects = createEffects(renderer, scene, camera);

  ui.show("loading");
  ui.setLoading(0, "Carregando...");
  const assets = await loadAssets(audio, (p) => ui.setLoading(p, `Carregando... ${Math.round(p * 100)}%`));
  ui.setLoading(1, "Preparando...");

  const view = createPlayerView({ camera, scene, flashlightModel: assets.flashlight, textures, quality: preset, lamp });

  let state = "LOADING";
  let session = null;
  let currentSeed = null;
  let introT = 0;
  let introLength = INTRO_LENGTH;
  // Progress carried across checkpoint retries of the same run.
  const run = { checkpoint: 0, timeOffset: 0 };
  let acc = 0;
  let last = performance.now();
  let loopErrors = 0;
  const monitor = createFrameMonitor();
  const dev = { timeScale: 1 }; // QA only (fast-forward); always 1 in production

  function applyPreset(p) {
    preset = p;
    renderer.setPixelRatio(Math.min((window.devicePixelRatio || 1) * p.pixelRatio, p.maxPixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight);
    const shadowChanged = renderer.shadowMap.enabled !== p.shadows;
    renderer.shadowMap.enabled = p.shadows;
    view.applyQuality(p);
    scene.fog.density = p.fog;
    camera.far = p.far;
    camera.updateProjectionMatrix();
    effects.setPreset(p);
    effects.setSize(window.innerWidth, window.innerHeight);
    session?.world.setPoolSize(p.poolLights);
    document.body.classList.toggle("post", p.post);
    if (shadowChanged) scene.traverse((o) => o.material && ([].concat(o.material).forEach((m) => (m.needsUpdate = true))));
  }
  applyPreset(preset);

  function disposeSession() {
    session?.dispose();
    session = null;
  }

  function makeSession(seed, mode, extra = {}) {
    disposeSession();
    session = createSession({ seed, mode, scene, lamp, textures, materials, quality: preset, audio, ui, view, assets, settings, camera, ...extra });
    acc = 0;
    return session;
  }

  // --- state transitions ---
  function enterMenu() {
    input.unlock();
    audio.resume();
    makeSession(`menu-${randomSeedLabel()}`, "menu");
    state = "MENU";
    ui.clearHud();
    ui.setHudVisible(false);
    ui.hideIntro();
    ui.setLockHint(false);
    ui.setFadeColor("#000");
    ui.setFade(0);
    ui.setMenuStats(stats);
    ui.show("menu");
  }

  // fromCheckpoint: resume the current run from its last completed objective.
  function startRun(seed, fromCheckpoint = false) {
    audio.resume();
    input.lock();
    if (!fromCheckpoint) {
      currentSeed = seed || settings.seed || randomSeedLabel();
      run.checkpoint = 0;
      run.timeOffset = 0;
    }
    try {
      makeSession(currentSeed, "game", { checkpoint: run.checkpoint, timeOffset: run.timeOffset });
    } catch (err) {
      log.error(err);
      currentSeed = randomSeedLabel();
      run.checkpoint = 0;
      run.timeOffset = 0;
      makeSession(currentSeed, "game");
    }
    stats.runs += fromCheckpoint ? 0 : 1;
    saveStats(stats);
    state = "INTRO";
    introT = 0;
    introLength = fromCheckpoint ? REWIND_LENGTH : INTRO_LENGTH;
    ui.hideScreens();
    ui.clearHud();
    ui.setHudVisible(false);
    ui.setLockHint(false);
    ui.setFadeColor("#000");
    ui.setFade(1);
    ui.showIntro(fromCheckpoint ? REWIND_LINES : INTRO_LINES);
    audio.glitch();
    monitor.reset();
  }

  function finishIntro() {
    if (state !== "INTRO") return;
    ui.hideIntro();
    session.beginWake();
    ui.setHudVisible(true);
    state = "PLAYING";
    if (!input.isLocked()) pause();
  }

  function pause() {
    if (state !== "PLAYING" || !session?.canPause()) return;
    state = "PAUSED";
    input.clear();
    audio.suspend();
    ui.setPauseObjective(session.currentObjectiveText());
    ui.show("pause");
  }

  // Acquiring the pointer lock is the single way back into PLAYING. This works the
  // same whether requestPointerLock returns a promise (Chromium) or not.
  function enterPlaying() {
    ui.hideScreens();
    ui.setLockHint(false);
    audio.resume();
    last = performance.now();
    acc = 0;
    state = "PLAYING";
  }

  async function resume() {
    if (state !== "PAUSED") return;
    const ok = await input.lock();
    if (state !== "PAUSED") return;
    // Already locked (no pointerlockchange will fire): resume directly.
    if (ok && input.isLocked()) {
      enterPlaying();
      return;
    }
    if (!ok) {
      // Browsers refuse re-locking right after Esc; ask for one more click.
      ui.hideScreens();
      ui.setLockHint(true);
    }
  }

  function endRun(kind) {
    const s = session.stats();
    input.unlock();
    state = kind === "win" ? "WIN" : "DEAD";
    ui.setHudVisible(false);
    ui.setPrompt(null, 0);
    const rows = [
      ["Tempo", formatTime(s.time)],
      ["Objetivos", `${s.objectives}/3`],
      ["Seed", s.seed],
    ];
    if (kind === "win") {
      const record = !stats.bestTime || s.time < stats.bestTime;
      stats.completed = true;
      if (record) stats.bestTime = s.time;
      rows.push(["Melhor tempo", `${formatTime(stats.bestTime)}${record ? "  (novo recorde)" : ""}`]);
    } else {
      stats.deaths += 1;
      run.checkpoint = s.objectives;
      run.timeOffset = s.time;
      ui.setRetryLabel(run.checkpoint > 0);
    }
    saveStats(stats);
    ui.setEndStats(kind, rows);
    ui.show(kind === "win" ? "win" : "dead");
    // The tape simply stops: cut to black behind the end card.
    ui.setFadeColor("#000");
    ui.setFade(1);
  }

  // --- UI actions ---
  ui.on("play", () => startRun());
  ui.on("resume", resume);
  ui.on("restart", () => startRun(currentSeed));
  ui.on("retry", () => startRun(currentSeed, true));
  ui.on("restartfull", () => startRun(currentSeed));
  ui.on("newseed", () => startRun(randomSeedLabel()));
  ui.on("menu", enterMenu);
  ui.on("fullscreen", () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => ui.message("Tela cheia indisponível.", 2));
  });
  document.addEventListener("fullscreenchange", () => ui.setFullscreenLabel(!!document.fullscreenElement));
  document.getElementById("lock-hint").addEventListener("click", resume);
  document.getElementById("intro").addEventListener("click", () => {
    input.lock();
    finishIntro();
  });
  // Any first interaction unlocks audio (autoplay policy) so the menu has its hum.
  window.addEventListener("pointerdown", () => audio.resume(), { once: true });

  ui.bindSettings(settings, (patch) => {
    Object.assign(settings, patch);
    saveSettings(settings);
    audio.setVolumes(settings);
    if ("quality" in patch) applyPreset(resolvePreset(settings.quality, renderer));
  });

  input.onLockChange((locked, error) => {
    if (locked && state === "PAUSED" && ui.screen !== "settings") enterPlaying();
    else if (!locked && state === "PLAYING") pause();
    if (error && state === "PAUSED" && ui.screen !== "settings") {
      ui.hideScreens();
      ui.setLockHint(true);
    }
  });
  input.onKey((code) => {
    if (state === "INTRO" && (code === "Space" || code === "Enter")) finishIntro();
    // Esc while paused (pointer already free): resume.
    else if (code === "Escape" && state === "PAUSED" && ui.screen === "pause") resume();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
  });
  window.addEventListener("blur", () => pause());
  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    effects.setSize(window.innerWidth, window.innerHeight);
  });

  // --- main loop ---
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    try {
      tick(dt);
      loopErrors = 0;
    } catch (err) {
      loopErrors++;
      log.error(err);
      if (loopErrors > 30) {
        state = "ERROR";
        input.unlock();
        audio.suspend();
        ui.showError(`Erro inesperado: ${err.message}`);
      }
    }
  }

  function tick(dt) {
    if (state === "ERROR" || !session) return;
    const running = state === "PLAYING" || state === "INTRO" || state === "MENU";
    let steps = 0;
    if (running) {
      if (state === "INTRO") {
        introT += dt;
        if (introT >= introLength) finishIntro();
      }
      acc += dt * dev.timeScale;
      while (acc >= STEP && steps < MAX_STEPS * dev.timeScale) {
        session.step(STEP, input);
        acc -= STEP;
        steps++;
      }
      if (steps >= MAX_STEPS * dev.timeScale) acc = 0;
    }
    const mouse = state === "PLAYING" ? input.consumeMouse() : (input.consumeMouse(), null);
    const s = session;
    s.frame(running ? dt : 0, acc / STEP, mouse, sensitivityToRadians(settings.sensitivity), { effects });
    if (s !== session) return;
    renderer.info.reset();
    effects.render(performance.now() / 1000, settings.reduceMotion);
    ui.tick(dt);
    if (state === "PLAYING") ui.peekObjective(input.isDown("Tab"));
    if (steps > 0 || !running) input.endFrame();

    if (state === "PLAYING" && session.result) endRun(session.result.type);

    // Auto quality: step down once if frames are consistently slow.
    if (state === "PLAYING" && settings.quality === "auto") {
      const avg = monitor.sample(dt);
      if (avg && avg > 1 / 38 && preset.name !== "low") {
        applyPreset(preset.name === "high" ? PRESETS.medium : PRESETS.low);
        ui.message("Qualidade ajustada automaticamente.", 2.5);
      }
    }
    debug?.update(dt);
  }

  let debug = null;
  if (import.meta.env.DEV) {
    const { createDebug } = await import("./systems/debug.js");
    debug = createDebug({
      renderer,
      scene,
      input,
      get session() {
        return session;
      },
      get state() {
        return state;
      },
      startRun,
      finishIntro,
      enterMenu,
      pause,
      resume,
      applyPreset: (name) => applyPreset(PRESETS[name]),
      settings,
      dev,
    });
  }

  enterMenu();
  requestAnimationFrame((t) => {
    last = t;
    frame(t);
  });
}

window.addEventListener("unhandledrejection", (e) => log.error("unhandled rejection", e.reason));

boot().catch((err) => {
  log.error(err);
  ui.showError(err?.message || String(err));
});
