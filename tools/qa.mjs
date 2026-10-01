// Automated browser QA over the Chrome DevTools Protocol (no npm dependencies;
// uses Node's built-in WebSocket). Drives the dev build through window.__game.
//
//   npm run dev                       (in another terminal)
//   node tools/qa.mjs smoke
//   node tools/qa.mjs playthrough seedA seedB ...
//   node tools/qa.mjs restart 15
//   node tools/qa.mjs longrun 10      (minutes)
//   node tools/qa.mjs edge
//
// Options via env: QA_URL (default http://localhost:5173/), QA_SIZE=1920x1080,
// QA_HEADFUL=1 (visible window, real GPU), QA_BROWSER=chrome|firefox (smoke only).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const URL_BASE = process.env.QA_URL || "http://localhost:5173/";
const [W, H] = (process.env.QA_SIZE || "1920x1080").split("x").map(Number);
const OUT = path.resolve(".qa");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "qa-chrome-"));
  const flags = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`,
    "--autoplay-policy=no-user-gesture-required",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization",
  ];
  if (!process.env.QA_HEADFUL) flags.push("--headless=new", "--use-angle=gl-egl");
  const proc = spawn("google-chrome", [...flags, "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === "page");
    } catch {
      /* not up yet */
    }
  }
  if (!target) throw new Error("chrome did not start");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const waiting = new Map();
  const consoleLog = [];
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && waiting.has(data.id)) {
      const { resolve, reject } = waiting.get(data.id);
      waiting.delete(data.id);
      data.error ? reject(new Error(data.error.message)) : resolve(data.result);
    } else if (data.method === "Runtime.consoleAPICalled") {
      consoleLog.push({ level: data.params.type, text: data.params.args.map((a) => a.value ?? a.description ?? "").join(" ") });
    } else if (data.method === "Runtime.exceptionThrown") {
      consoleLog.push({ level: "exception", text: data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text });
    } else if (data.method === "Log.entryAdded") {
      consoleLog.push({ level: data.params.entry.level, text: data.params.entry.text });
    }
  };
  // Every CDP call times out so a hung page fails loudly instead of stalling the run.
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      const timer = setTimeout(() => {
        waiting.delete(mid);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
      waiting.set(mid, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  const page = {
    send,
    consoleLog,
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async goto(url) {
      await send("Page.navigate", { url });
      for (let i = 0; i < 100; i++) {
        await sleep(200);
        if (await page.eval("!!window.__game && window.__game.state === 'MENU'").catch(() => false)) return;
      }
      throw new Error("menu never appeared");
    },
    async shot(name) {
      const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 82 });
      fs.writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(r.data, "base64"));
    },
    async close() {
      ws.close();
      proc.kill("SIGTERM");
      await sleep(300);
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
  return page;
}

async function startRun(page, seed) {
  await page.eval(`__game.start(${JSON.stringify(seed)})`);
  await page.eval("__game.virtualLock(true)");
  await sleep(500);
  await page.eval("__game.skipIntro()");
  await sleep(300);
}

const errorsOf = (page) => page.consoleLog.filter((l) => l.level === "error" || l.level === "exception" || l.level === "warning" || l.level === "warn");

const scenarios = {
  // Every model and sample blocked: the game must still boot, play and use fallbacks.
  async assetfail(page) {
    await page.send("Network.enable");
    await page.send("Network.setBlockedURLs", { urls: ["*.glb", "*.ogg"] });
    await page.goto(`${URL_BASE}?debug`);
    await startRun(page, "assetfail-1");
    await sleep(3800);
    await page.eval("__game.key('KeyW', true)");
    await sleep(1500);
    await page.eval("__game.key('KeyW', false)");
    await page.shot("assetfail-play");
    return { state: await page.eval("__game.state"), phase: (await page.eval("__game.info()")).phase };
  },

  // Clean screenshots for the README (no debug overlay).
  async readme(page) {
    const dir = path.resolve("docs/screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const save = async (n) => {
      const r = await page.send("Page.captureScreenshot", { format: "jpeg", quality: 80 });
      fs.writeFileSync(path.join(dir, `${n}.jpg`), Buffer.from(r.data, "base64"));
    };
    await page.goto(URL_BASE);
    await sleep(2500);
    await save("menu");
    await startRun(page, "readme-7");
    await page.eval("__game.god(true)");
    await sleep(4200);
    await page.eval("__game.viewpoint('corridor')");
    await sleep(900);
    await save("corridor");
    for (const name of ["hall", "panel", "tv"]) {
      await page.eval(`__game.viewpoint('${name}')`);
      if (name === "tv") await page.eval("__game.flashlight()");
      await sleep(1200);
      await save(name);
    }
    await page.eval("__game.flashlight()");
    await page.eval("__game.viewpoint('corridor')");
    await page.eval("__game.monsterAhead(9)");
    await sleep(700);
    await save("creature");
    await page.eval("__game.setStage(2)");
    await sleep(6000);
    await page.eval("__game.viewpoint('door', 3.2)");
    await sleep(1500);
    await save("door");
    return fs.readdirSync(dir);
  },

  // Production build: no debug API. Pointer lock is refused (no real user gesture),
  // so after the intro the game must land in PAUSED instead of running unlocked.
  async prodflow(page) {
    await page.send("Page.navigate", { url: URL_BASE });
    await sleep(6000);
    const menu = await page.eval("document.querySelector('.screen.active')?.id");
    await page.eval("document.querySelector('#screen-menu [data-action=play]').click()");
    await sleep(11000);
    await page.shot("prodflow");
    return {
      menu,
      after: await page.eval("document.querySelector('.screen.active')?.id || null"),
      lockHint: await page.eval("!document.getElementById('lock-hint').classList.contains('hidden')"),
      hud: await page.eval("!document.getElementById('hud').classList.contains('hidden')"),
    };
  },

  async probe(page) {
    await page.send("Page.navigate", { url: `${URL_BASE}?debug` });
    await sleep(8000);
    await page.shot("probe");
    return page.eval("({ game: !!window.__game, state: window.__game && window.__game.state, screen: document.querySelector('.screen.active')?.id, loading: document.getElementById('loading-text').textContent, err: document.getElementById('error-text').textContent })");
  },
  async smoke(page) {
    await page.goto(`${URL_BASE}?debug`);
    await sleep(1500);
    await page.shot("01-menu");
    await startRun(page, "smoke-1");
    await sleep(3500);
    await page.shot("02-wake");
    const info1 = await page.eval("__game.info()");
    await page.eval("__game.key('KeyF', true)");
    await sleep(100);
    await page.eval("__game.key('KeyF', false)");
    await page.eval("__game.key('KeyW', true)");
    await sleep(2500);
    await page.eval("__game.key('KeyW', false)");
    await page.shot("03-walk-flashlight");
    await sleep(1500);
    const render = await page.eval("__game.renderInfo()");
    const fps = await page.eval("__game.fps()");
    const info2 = await page.eval("__game.info()");
    await page.eval("__game.pause()");
    await sleep(500);
    await page.shot("04-pause");
    return { gpu: await page.eval("(() => { const gl = document.querySelector('canvas').getContext('webgl2'); const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; })()"), info1, info2, render, fps };
  },

  async playthrough(page, ...seeds) {
    const results = [];
    for (const seed of seeds.length ? seeds : ["pt-1"]) {
      await page.goto(`${URL_BASE}?debug`);
      await startRun(page, seed);
      await page.eval("__game.god(true)");
      await page.eval("__game.timeScale && __game.timeScale(4)");
      await sleep(4000);
      await page.eval("__game.autopilot(true)");
      const t0 = Date.now();
      let state = "PLAYING";
      let lastObjective = null;
      const timeline = [];
      while (Date.now() - t0 < 6 * 60 * 1000) {
        await sleep(1000);
        state = await page.eval("__game.state");
        if (state !== "PLAYING") break;
        const info = await page.eval("__game.info()");
        if (info.objective !== lastObjective) {
          timeline.push({ objective: info.objective, gameTime: Math.round(info.time) });
          await page.shot(`pt-${seed}-${info.objective}`);
          lastObjective = info.objective;
        }
      }
      await page.shot(`pt-${seed}-end`);
      const log = await page.eval("__game.log");
      results.push({ seed, state, realSeconds: Math.round((Date.now() - t0) / 1000), timeline, autopilotStuck: log.length, fps: await page.eval("__game.fps()") });
    }
    return results;
  },

  async chase(page) {
    await page.goto(`${URL_BASE}?debug`);
    await startRun(page, "chase-1");
    await sleep(1500);
    await page.eval("__game.setStage(2)");
    await page.eval("__game.monsterNear()");
    const trace = [];
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const st = await page.eval("__game.state");
      const info = await page.eval("__game.info()");
      trace.push(`${st} ${info.stage} ${info.monster.state} aw=${info.monster.awareness.toFixed(2)} sees=${info.monster.sees} d=${Math.hypot(info.monster.x - info.player.x, info.monster.z - info.player.z).toFixed(1)}`);
      if (st === "DEAD") break;
      if (i === 6) await page.shot("chase-mid");
    }
    await page.shot("chase-end");
    return trace;
  },

  async checkpoint(page) {
    await page.goto(`${URL_BASE}?debug`);
    await startRun(page, "cp-1");
    await sleep(3600);
    await page.eval("__game.setStage(2)");
    await sleep(500);
    await page.eval("__game.kill()");
    for (let i = 0; i < 60 && (await page.eval("__game.state")) !== "DEAD"; i++) await sleep(250);
    const deadState = await page.eval("__game.state");
    const pre = await page.eval("__game.info()");
    const label = await page.eval("document.querySelector('#screen-dead [data-action=retry]').textContent");
    await page.shot("cp-dead");
    await page.eval("document.querySelector('#screen-dead [data-action=retry]').click()");
    await page.eval("__game.virtualLock(true)");
    await sleep(2800);
    const info = await page.eval("__game.info()");
    await sleep(2500);
    await page.shot("cp-restored");
    return { deadState, preStage: pre.stage, preMonster: pre.monster.state, label, state: await page.eval("__game.state"), objective: info.objective, stage: info.stage, phase: info.phase, monsterDist: Math.hypot(info.monster.x - info.player.x, info.monster.z - info.player.z) };
  },

  async flow(page) {
    await page.goto(`${URL_BASE}?debug`);
    await page.eval("document.querySelector('#screen-menu [data-action=settings]').click()");
    await sleep(500);
    await page.shot("flow-settings");
    await page.eval("document.querySelector('#screen-settings [data-action=back]').click()");
    await page.eval("__game.start('flow-1')");
    await page.eval("__game.virtualLock(true)");
    await sleep(6200);
    await page.shot("flow-intro");
    await page.eval("__game.skipIntro()");
    await sleep(1100);
    await page.shot("flow-wake");
    await page.eval("__game.god(true)");
    await page.eval("__game.setStage(4)");
    await sleep(500);
    const info = await page.eval("__game.info()");
    await page.eval("__game.viewpoint('door', 1.2)");
    await page.eval("__game.look(__game.info() && Math.atan2(0, 0))");
    await page.eval("__game.autopilot(true)");
    let state = "";
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      state = await page.eval("__game.state");
      const phase = (await page.eval("__game.info()")).phase;
      if (phase === "winning" && i % 4 === 0) await page.shot(`flow-winning-${i}`);
      if (state === "WIN") break;
    }
    await sleep(600);
    await page.shot("flow-win");
    return { stageInfo: info.stage, objective: info.objective, state };
  },

  async gallery(page, seed = "gallery") {
    await page.goto(`${URL_BASE}?debug`);
    await startRun(page, seed);
    await page.eval("__game.god(true)");
    await sleep(3600);
    for (const name of ["panel", "tv", "hall"]) {
      await page.eval(`__game.viewpoint('${name}')`);
      await sleep(900);
      await page.shot(`gal-${name}`);
    }
    await page.eval("__game.setStage(2)");
    await page.eval("__game.viewpoint('door', 3.2)");
    await sleep(1500);
    await page.shot("gal-door");
    await page.eval("__game.viewpoint('hall')");
    await page.eval("__game.monsterNear()");
    await sleep(700);
    await page.shot("gal-creature");
    await page.eval("__game.flashlight()");
    await sleep(700);
    await page.shot("gal-creature-flashlight");
    return page.eval("__game.info()");
  },

  async restart(page, countArg = "12") {
    const count = Number(countArg);
    await page.goto(`${URL_BASE}?debug`);
    const samples = [];
    for (let i = 0; i < count; i++) {
      await startRun(page, `restart-${i}`);
      await page.eval("__game.key('KeyW', true)");
      await sleep(1200);
      await page.eval("__game.key('KeyW', false)");
      await page.eval("__game.menu()");
      await sleep(600);
      await page.send("HeapProfiler.collectGarbage").catch(() => {});
      const r = await page.eval("__game.renderInfo()");
      const m = await page.eval("__game.memory()");
      const listeners = await page.eval("document.querySelectorAll('*').length");
      samples.push({ i, geometries: r.geometries, textures: r.textures, programs: r.programs, heapMB: m ? +(m.used / 1048576).toFixed(1) : null, domNodes: listeners });
    }
    return samples;
  },

  async longrun(page, minutesArg = "10", stageArg = "0") {
    const minutes = Number(minutesArg);
    await page.goto(`${URL_BASE}?debug`);
    await startRun(page, "longrun");
    await page.eval("__game.god(true)");
    if (Number(stageArg) > 0) {
      await sleep(3600);
      await page.eval(`__game.setStage(${Number(stageArg)})`);
      await page.eval("__game.monsterNear()");
    }
    const samples = [];
    const t0 = Date.now();
    let k = 0;
    while (Date.now() - t0 < minutes * 60 * 1000) {
      // Wander: walk, turn, sprint, toggle the light.
      await page.eval(`__game.key('KeyW', true); __game.key('ShiftLeft', ${k % 3 === 0}); __game.look(${(k * 1.7) % 6.28})`);
      await sleep(4000);
      if (k % 5 === 0) await page.eval("__game.key('KeyF', true); setTimeout(() => __game.key('KeyF', false), 50)");
      if (k % 15 === 0) {
        await page.send("HeapProfiler.collectGarbage").catch(() => {});
        const r = await page.eval("__game.renderInfo()");
        const m = await page.eval("__game.memory()");
        const f = await page.eval("__game.fps()");
        const i = await page.eval("__game.info()");
        samples.push({ minute: +((Date.now() - t0) / 60000).toFixed(1), state: await page.eval("__game.state"), fps: f.fps, worstMs: f.worstMs, calls: r.calls, geometries: r.geometries, textures: r.textures, heapMB: m ? +(m.used / 1048576).toFixed(1) : null, monster: i.monster.state, stage: i.stage, tension: +i.tension.toFixed(2) });
        fs.writeFileSync(path.join(OUT, "longrun-progress.json"), JSON.stringify(samples, null, 1));
      }
      k++;
    }
    await page.eval("__game.key('KeyW', false); __game.key('ShiftLeft', false)");
    return samples;
  },

  async edge(page) {
    const out = {};
    await page.goto(`${URL_BASE}?debug`);
    await startRun(page, "edge-1");
    await sleep(1500);
    // Pause stops the simulation (creature position frozen).
    await page.eval("__game.monsterNear()");
    await page.eval("__game.setStage(2)");
    await sleep(300);
    await page.eval("__game.pause()");
    const a = await page.eval("__game.info()");
    await sleep(2500);
    const b = await page.eval("__game.info()");
    out.pauseFreezes = a.monster.x === b.monster.x && a.monster.z === b.monster.z && a.time === b.time;
    out.pausedState = await page.eval("__game.state");
    // Lock already held when resuming (no lock-change event will fire).
    await page.eval("__game.resume()");
    await sleep(300);
    out.resumedState = await page.eval("__game.state");
    // Death sequence -> DEAD screen.
    await page.eval("__game.god(false)");
    await sleep(2500);
    await page.eval("__game.kill()");
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      if ((await page.eval("__game.state")) === "DEAD") break;
    }
    out.deathState = await page.eval("__game.state");
    await page.shot("edge-dead");
    // Exit before objectives: locked message.
    await startRun(page, "edge-2");
    await sleep(800);
    const exitInfo = await page.eval("(() => { const s = __game.info(); return s; })()");
    out.startObjective = exitInfo.objective;
    // Quality switches at runtime.
    for (const q of ["low", "medium", "high"]) {
      await page.eval(`__game.quality('${q}')`);
      await sleep(800);
      out[`quality_${q}`] = await page.eval("__game.renderInfo()");
      await page.shot(`edge-quality-${q}`);
    }
    // Visibility/blur pause.
    await page.eval("window.dispatchEvent(new Event('blur'))");
    await sleep(200);
    out.blurState = await page.eval("__game.state");
    return out;
  },
};

// Firefox smoke test over WebDriver BiDi (Firefox no longer speaks CDP).
async function firefoxSmoke() {
  const port = 9900 + Math.floor(Math.random() * 90);
  // Snap-packaged Firefox cannot see the host /tmp; use its own writable area when present.
  const snapCommon = path.join(os.homedir(), "snap", "firefox", "common");
  const profile = fs.mkdtempSync(path.join(fs.existsSync(snapCommon) ? snapCommon : os.tmpdir(), "qa-firefox-"));
  const proc = spawn("firefox", ["--headless", "--no-remote", "--profile", profile, `--remote-debugging-port=${port}`, `--window-size=${W},${H}`], { stdio: "ignore" });
  let ws;
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(300);
    try {
      const sock = new WebSocket(`ws://127.0.0.1:${port}/session`);
      await new Promise((r, j) => ((sock.onopen = r), (sock.onerror = j)));
      ws = sock;
    } catch {
      /* not up yet */
    }
  }
  if (!ws) throw new Error("firefox did not start");
  let id = 0;
  const waiting = new Map();
  const logs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) {
      const w = waiting.get(d.id);
      waiting.delete(d.id);
      d.type === "error" ? w.reject(new Error(d.message || d.error)) : w.resolve(d.result);
    } else if (d.method === "log.entryAdded") logs.push({ level: d.params.level, text: d.params.text });
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      waiting.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  try {
    await send("session.new", { capabilities: {} });
    await send("session.subscribe", { events: ["log.entryAdded"] });
    const tree = await send("browsingContext.getTree", {});
    const context = tree.contexts[0].context;
    await send("browsingContext.setViewport", { context, viewport: { width: W, height: H } }).catch(() => {});
    await send("browsingContext.navigate", { context, url: `${URL_BASE}?debug`, wait: "complete" });
    const evalJs = async (expression) => {
      const r = await send("script.evaluate", { expression, target: { context }, awaitPromise: true, resultOwnership: "none" });
      return r.result?.value;
    };
    let state = null;
    for (let i = 0; i < 60 && state !== "MENU"; i++) {
      await sleep(500);
      state = await evalJs("window.__game ? window.__game.state : document.querySelector('.screen.active')?.id || 'none'");
    }
    const shot = async (n) => {
      const r = await send("browsingContext.captureScreenshot", { context });
      fs.writeFileSync(path.join(OUT, `${n}.png`), Buffer.from(r.data, "base64"));
    };
    await shot("ff-menu");
    const out = { menuState: state };
    if (state === "MENU") {
      await evalJs("__game.start('ff-1'); __game.virtualLock(true); true");
      await sleep(800);
      await evalJs("__game.skipIntro(); true");
      await sleep(4000);
      await evalJs("__game.key('KeyW', true); true");
      await sleep(2000);
      await evalJs("__game.key('KeyW', false); __game.key('KeyF', true); true");
      await sleep(200);
      await evalJs("__game.key('KeyF', false); true");
      await sleep(1500);
      await shot("ff-play");
      out.state = await evalJs("__game.state");
      out.info = JSON.parse(await evalJs("JSON.stringify(__game.info())"));
      out.render = JSON.parse(await evalJs("JSON.stringify(__game.renderInfo())"));
      out.fps = JSON.parse(await evalJs("JSON.stringify(__game.fps())"));
      out.gpu = await evalJs("(() => { const gl = document.createElement('canvas').getContext('webgl2'); return gl ? gl.getParameter(gl.RENDERER) : 'none'; })()");
    }
    return { result: out, logs: logs.filter((l) => l.level === "error" || l.level === "warn") };
  } finally {
    // Close through the protocol: confined (snap) Firefox may not accept signals from us.
    await Promise.race([send("browser.close").catch(() => {}), sleep(5000)]);
    ws.close();
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone or not signalable */
    }
    await sleep(1000);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

const [name = "smoke", ...rest] = process.argv.slice(2);
if (name === "firefox") {
  const report = await firefoxSmoke().catch((err) => ({ error: String(err.stack || err) }));
  fs.writeFileSync(path.join(OUT, "firefox.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
const page = await launch();
let result;
try {
  result = await scenarios[name](page, ...rest);
} catch (err) {
  result = { error: String(err.stack || err) };
}
const errors = errorsOf(page);
const report = { scenario: name, size: `${W}x${H}`, result, consoleIssues: errors.slice(0, 40), consoleIssueCount: errors.length };
fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await page.close();
process.exit(0);
