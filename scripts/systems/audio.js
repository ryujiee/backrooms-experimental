// Web Audio engine. Three persisted buses (master / effects / ambience), each with
// a dry path and a reverb path. Almost everything is synthesised (hum, room tone,
// drones, heartbeat, breathing, knocks, pops, alarms); the three original samples
// are reused with pitch/filter variation. Per-session nodes hang off a session
// gain per bus, so ending a run disconnects every sound it created in one place.

import { log } from "../core/log.js";

const SAMPLE_URLS = {
  step: "assets/audio/footstep.ogg",
  click: "assets/audio/flashlight_click.ogg",
  scream: "assets/audio/monster_scream.ogg",
};

function makeImpulse(ctx, seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

function makeNoise(ctx, seconds, color) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (color === "brown") {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else if (color === "pink") {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
    } else d[i] = w;
  }
  return buf;
}

function silentAudio() {
  return new Proxy(
    { available: false, preload: async () => {}, isRunning: () => false },
    { get: (target, key) => (key in target ? target[key] : () => {}) }
  );
}

export function createAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return silentAudio();
  let ctx;
  try {
    ctx = new AC({ latencyHint: "interactive" });
  } catch (err) {
    log.warn("AudioContext unavailable", err);
    return silentAudio();
  }

  const now = () => ctx.currentTime;
  const samples = {};
  const noise = makeNoise(ctx, 2, "white");
  const brown = makeNoise(ctx, 4, "brown");
  const pink = makeNoise(ctx, 3, "pink");

  const master = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -8;
  limiter.knee.value = 6;
  limiter.ratio.value = 10;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  master.connect(limiter).connect(ctx.destination);

  function makeBus() {
    const out = ctx.createGain();
    out.connect(master);
    const wet = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.buffer = makeImpulse(ctx, 2.6, 2.4);
    const wetOut = ctx.createGain();
    wetOut.gain.value = 0.55;
    wet.connect(conv).connect(wetOut).connect(out);
    return { out, wet };
  }
  const buses = { sfx: makeBus(), amb: makeBus() };

  // --- session graph ---------------------------------------------------------
  let session = null;

  function startSession() {
    endSession();
    const s = {
      sfx: ctx.createGain(),
      sfxWet: ctx.createGain(),
      amb: ctx.createGain(),
      ambWet: ctx.createGain(),
      loops: [],
      timers: { heart: 0, breath: 0, beacon: 0, breathPhase: 0 },
      monster: null,
      locators: {},
      lampBuzz: [],
      state: { tension: 0, chase: 0, exertion: 0, stress: 0, power: 0.7, humCut: 0, beacon: false, alarm: false, outside: 0 },
    };
    s.sfx.connect(buses.sfx.out);
    s.sfxWet.connect(buses.sfx.wet);
    s.amb.connect(buses.amb.out);
    s.ambWet.connect(buses.amb.wet);
    session = s;
    buildAmbience(s);
    buildMonsterVoice(s);
    return s;
  }

  function endSession() {
    if (!session) return;
    const s = session;
    session = null;
    const t = now();
    for (const n of [s.sfx, s.sfxWet, s.amb, s.ambWet]) {
      n.gain.cancelScheduledValues(t);
      n.gain.setValueAtTime(n.gain.value, t);
      n.gain.linearRampToValueAtTime(0, t + 0.08);
    }
    // Stop sources and drop the graph after the fade; everything is GC'd once disconnected.
    setTimeout(() => {
      for (const src of s.loops) {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
      }
      for (const n of [s.sfx, s.sfxWet, s.amb, s.ambWet]) n.disconnect();
    }, 150);
  }

  function loopSource(s, buffer, rate = 1) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = rate;
    src.start(now(), Math.random() * buffer.duration);
    s.loops.push(src);
    return src;
  }

  function osc(s, type, freq) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.start();
    s.loops.push(o);
    return o;
  }

  function gainNode(v = 0) {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  }

  function filter(type, freq, q = 0.7) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  function panner({ ref = 2, rolloff = 1.2, max = 60, hrtf = true } = {}) {
    const p = ctx.createPanner();
    p.panningModel = hrtf ? "HRTF" : "equalpower";
    p.distanceModel = "inverse";
    p.refDistance = ref;
    p.rolloffFactor = rolloff;
    p.maxDistance = max;
    return p;
  }

  function setPos(p, x, y, z) {
    if (p.positionX) {
      p.positionX.setTargetAtTime(x, now(), 0.02);
      p.positionY.setTargetAtTime(y, now(), 0.02);
      p.positionZ.setTargetAtTime(z, now(), 0.02);
    } else p.setPosition(x, y, z);
  }

  function buildAmbience(s) {
    // Fluorescent hum: mains fundamental + harmonics, slow drift, plus a high buzz.
    s.hum = gainNode(0);
    const humFilter = filter("lowpass", 520);
    humFilter.connect(s.hum).connect(s.amb);
    const h60 = osc(s, "sine", 60);
    const h120 = osc(s, "sine", 120);
    const h180 = osc(s, "triangle", 180);
    const drift = osc(s, "sine", 0.07);
    const driftAmt = gainNode(0.35);
    drift.connect(driftAmt);
    driftAmt.connect(h60.frequency);
    driftAmt.connect(h120.frequency);
    [
      [h60, 0.05],
      [h120, 0.035],
      [h180, 0.012],
    ].forEach(([o, v]) => o.connect(gainNode(v)).connect(humFilter));
    const buzzSrc = loopSource(s, noise);
    const buzzBand = filter("bandpass", 3400, 7);
    const buzzGain = gainNode(0.018);
    const buzzLfo = osc(s, "sine", 0.13);
    const buzzLfoAmt = gainNode(0.012);
    buzzLfo.connect(buzzLfoAmt).connect(buzzGain.gain);
    buzzSrc.connect(buzzBand).connect(buzzGain).connect(s.hum);

    // Room tone.
    const room = loopSource(s, brown);
    room.connect(filter("lowpass", 280)).connect(gainNode(0.11)).connect(s.amb);

    // Low drone driven by tension.
    s.drone = gainNode(0);
    const droneFilter = filter("lowpass", 140);
    droneFilter.connect(s.drone).connect(s.amb);
    osc(s, "sine", 41).connect(droneFilter);
    osc(s, "sine", 43.7).connect(droneFilter);
    osc(s, "sawtooth", 55.2).connect(gainNode(0.15)).connect(droneFilter);

    // Very quiet high beating tone at high tension (unease, not music).
    s.high = gainNode(0);
    s.high.connect(s.amb);
    osc(s, "sine", 1975).connect(s.high);
    osc(s, "sine", 1982.5).connect(s.high);

    // Chase rumble.
    s.rumble = gainNode(0);
    loopSource(s, brown, 0.6).connect(filter("lowpass", 95)).connect(s.rumble).connect(s.sfx);

    // Outside air for the ending.
    s.outside = gainNode(0);
    const wind = loopSource(s, pink, 0.8);
    const windFilter = filter("lowpass", 700);
    const windLfo = osc(s, "sine", 0.09);
    windLfo.connect(gainNode(350)).connect(windFilter.frequency);
    wind.connect(windFilter).connect(s.outside).connect(s.amb);

    // Two positional lamp buzzes that follow the nearest lit fixtures.
    for (let k = 0; k < 2; k++) {
      const p = panner({ ref: 1.2, rolloff: 1.6, max: 20 });
      const g = gainNode(0.035);
      const src = osc(s, "sawtooth", 120 + k * 0.7);
      src.connect(filter("bandpass", 2600, 2.5)).connect(g).connect(p).connect(s.amb);
      s.lampBuzz.push({ p, g });
    }
  }

  function buildMonsterVoice(s) {
    const p = panner({ ref: 2.2, rolloff: 1.35, max: 50 });
    const g = gainNode(0);
    const growl = loopSource(s, brown, 1.4);
    const band = filter("bandpass", 260, 2.2);
    const am = gainNode(0.5);
    const amLfo = osc(s, "square", 7.3);
    amLfo.connect(gainNode(0.45)).connect(am.gain);
    growl.connect(band).connect(am).connect(g);
    const sub = osc(s, "sawtooth", 47);
    sub.connect(filter("lowpass", 180)).connect(gainNode(0.25)).connect(g);
    const wetSend = gainNode(0.35);
    g.connect(p);
    p.connect(s.sfx);
    p.connect(wetSend).connect(s.sfxWet);
    s.monster = { p, g, band };
  }

  // --- one-shots ---------------------------------------------------------------
  // Plays `build(t, dest)` positioned in 3D (or centred if pos is null).
  function shot(pos, build, { bus = "sfx", wet = 0.25, ref = 2, rolloff = 1.2, gain = 1 } = {}) {
    const s = session;
    if (!s) return;
    const out = gainNode(gain);
    let tail = out;
    if (pos) {
      const p = panner({ ref, rolloff });
      setPos(p, pos.x, pos.y ?? 1.2, pos.z);
      out.connect(p);
      tail = p;
    }
    tail.connect(bus === "sfx" ? s.sfx : s.amb);
    const wetGain = wet > 0 ? gainNode(wet) : null;
    if (wetGain) tail.connect(wetGain).connect(bus === "sfx" ? s.sfxWet : s.ambWet);
    const t0 = now();
    const dur = build(t0, out) || 2;
    // Cleanup on the audio clock (not setTimeout), so a pause never cuts a sound short.
    const timer = ctx.createConstantSource();
    timer.offset.value = 0;
    timer.connect(out);
    timer.onended = () => {
      out.disconnect();
      tail.disconnect();
      wetGain?.disconnect();
    };
    timer.start(t0);
    timer.stop(t0 + dur + 0.5);
  }

  function env(g, t, a, peak, d) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  function burst(t, dest, { buffer = noise, type = "bandpass", freq = 800, q = 1, a = 0.005, peak = 0.5, d = 0.2, rate = 1 } = {}) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const f = filter(type, freq, q);
    const g = gainNode(0);
    env(g, t, a, peak, d);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * (buffer.duration - a - d - 0.1));
    src.stop(t + a + d + 0.05);
  }

  function tone(t, dest, { type = "sine", f0 = 80, f1 = f0, a = 0.005, peak = 0.4, d = 0.3 } = {}) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + a + d);
    const g = gainNode(0);
    env(g, t, a, peak, d);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + a + d + 0.05);
  }

  function sample(t, dest, name, { rate = 1, offset = 0, duration, peak = 1, lowpass = 20000, fadeIn = 0.005 } = {}) {
    const buf = samples[name];
    if (!buf) return false;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const f = filter("lowpass", lowpass);
    const g = gainNode(0);
    const len = duration ?? (buf.duration - offset) / rate;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + fadeIn);
    g.gain.setValueAtTime(peak, t + Math.max(fadeIn, len - 0.25));
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.connect(f).connect(g).connect(dest);
    src.start(t, offset, len * rate + 0.05);
    return true;
  }

  let stepSide = 1;

  const api = {
    available: true,
    context: ctx,

    async preload(onProgress) {
      const entries = Object.entries(SAMPLE_URLS);
      let done = 0;
      await Promise.all(
        entries.map(async ([name, url]) => {
          try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            samples[name] = await ctx.decodeAudioData(await res.arrayBuffer());
          } catch (err) {
            log.warn(`audio sample "${name}" failed, using synthesis fallback`, err);
          } finally {
            onProgress?.(++done / entries.length);
          }
        })
      );
    },

    resume() {
      if (ctx.state !== "running") return ctx.resume().catch(() => {});
      return Promise.resolve();
    },
    suspend() {
      if (ctx.state === "running") return ctx.suspend().catch(() => {});
      return Promise.resolve();
    },
    isRunning: () => ctx.state === "running",

    setVolumes({ master: m, sfx, ambience }) {
      // Perceptual curve.
      const curve = (v) => Math.pow(Math.max(0, Math.min(100, v)) / 100, 2);
      const t = now();
      master.gain.setTargetAtTime(curve(m) * 1.1, t, 0.03);
      buses.sfx.out.gain.setTargetAtTime(curve(sfx), t, 0.03);
      buses.amb.out.gain.setTargetAtTime(curve(ambience), t, 0.03);
    },

    startSession,
    endSession,

    setListener(pos, forward) {
      const l = ctx.listener;
      if (l.positionX) {
        const t = now();
        l.positionX.setValueAtTime(pos.x, t);
        l.positionY.setValueAtTime(pos.y, t);
        l.positionZ.setValueAtTime(pos.z, t);
        l.forwardX.setValueAtTime(forward.x, t);
        l.forwardY.setValueAtTime(forward.y, t);
        l.forwardZ.setValueAtTime(forward.z, t);
        l.upX.setValueAtTime(0, t);
        l.upY.setValueAtTime(1, t);
        l.upZ.setValueAtTime(0, t);
      } else {
        l.setPosition(pos.x, pos.y, pos.z);
        l.setOrientation(forward.x, forward.y, forward.z, 0, 1, 0);
      }
    },

    // Continuous layers, driven once per frame by the session.
    update(dt, st) {
      const s = session;
      if (!s) return;
      Object.assign(s.state, st);
      const t = now();
      const k = s.state;
      const humLevel = k.power * (1 - k.humCut) * (1 - k.outside);
      s.hum.gain.setTargetAtTime(humLevel, t, k.humCut > 0.5 ? 0.01 : 0.4);
      s.drone.gain.setTargetAtTime(0.02 + k.tension * 0.12, t, 0.8);
      s.high.gain.setTargetAtTime(Math.max(0, k.tension - 0.55) * 0.012, t, 1.2);
      s.rumble.gain.setTargetAtTime(k.chase * 0.55, t, k.chase > 0 ? 0.6 : 2.5);
      s.outside.gain.setTargetAtTime(k.outside * 0.5, t, 1.5);

      // Heartbeat: only once things get tense.
      const heartDrive = Math.max(k.chase, (k.tension - 0.45) / 0.55);
      if (heartDrive > 0) {
        s.timers.heart -= dt;
        if (s.timers.heart <= 0) {
          const bpm = 62 + heartDrive * 78;
          s.timers.heart = 60 / bpm;
          const v = 0.12 + heartDrive * 0.4;
          shot(null, (t0, dest) => {
            tone(t0, dest, { f0: 62, f1: 38, a: 0.008, peak: v, d: 0.14 });
            tone(t0 + 0.27, dest, { f0: 55, f1: 35, a: 0.008, peak: v * 0.6, d: 0.12 });
            return 0.5;
          }, { wet: 0 });
        }
      }

      // Breathing: exertion (stamina) and stress (tension/chase).
      const drive = Math.max(k.exertion, k.stress * 0.85);
      if (drive > 0.12) {
        s.timers.breath -= dt;
        if (s.timers.breath <= 0) {
          const cycle = 3.2 - drive * 2.2;
          s.timers.breath = cycle * (0.9 + Math.random() * 0.2);
          const loud = 0.03 + drive * 0.16;
          shot(null, (t0, dest) => {
            burst(t0, dest, { buffer: pink, freq: 1200 + drive * 500, q: 0.8, a: cycle * 0.3, peak: loud * 0.8, d: cycle * 0.12 });
            burst(t0 + cycle * 0.45, dest, { buffer: pink, freq: 750, q: 0.7, a: 0.06, peak: loud, d: cycle * 0.35 });
            return cycle;
          }, { wet: 0 });
        }
      }

      // Exit beacon / alarm.
      if (k.beacon && k.exitPos) {
        s.timers.beacon -= dt;
        if (s.timers.beacon <= 0) {
          s.timers.beacon = k.alarm ? 1.2 : 3.2;
          shot(k.exitPos, (t0, dest) => {
            if (k.alarm) {
              tone(t0, dest, { type: "square", f0: 440, a: 0.02, peak: 0.12, d: 0.5 });
              tone(t0 + 0.6, dest, { type: "square", f0: 554, a: 0.02, peak: 0.12, d: 0.5 });
            } else tone(t0, dest, { type: "sine", f0: 880, a: 0.01, peak: 0.08, d: 0.35 });
            return 1.4;
          }, { ref: 3, rolloff: 0.9, wet: 0.5 });
        }
      }
    },

    setLampBuzz(points) {
      if (!session) return;
      session.lampBuzz.forEach((b, i) => {
        const p = points[i];
        b.g.gain.setTargetAtTime(p ? 0.035 : 0, now(), 0.3);
        if (p) setPos(b.p, p.x, 2.8, p.z);
      });
    },

    // Creature voice: level by state (quiet when patrolling, loud in chase).
    setMonster(pos, level, aggression) {
      const m = session?.monster;
      if (!m) return;
      setPos(m.p, pos.x, 1.4, pos.z);
      m.g.gain.setTargetAtTime(level, now(), 0.25);
      m.band.frequency.setTargetAtTime(220 + aggression * 260, now(), 0.3);
    },

    // Looping positional locator (panel buzz, TV static, door grinding).
    setLocator(name, pos, on, kind) {
      const s = session;
      if (!s) return;
      let loc = s.locators[name];
      if (!loc && on) {
        const p = panner({ ref: 1.5, rolloff: 1.1, max: 40 });
        const g = gainNode(0);
        if (kind === "static") {
          loopSource(s, noise).connect(filter("bandpass", 3600, 0.6)).connect(gainNode(0.25)).connect(g);
          loopSource(s, noise, 0.5).connect(filter("lowpass", 500)).connect(gainNode(0.12)).connect(g);
        } else if (kind === "grind") {
          loopSource(s, brown, 0.8).connect(filter("bandpass", 170, 3)).connect(gainNode(1.2)).connect(g);
          osc(s, "sawtooth", 38).connect(filter("lowpass", 160)).connect(gainNode(0.25)).connect(g);
        } else {
          osc(s, "sawtooth", 100).connect(filter("bandpass", 1600, 1.5)).connect(gainNode(0.18)).connect(g);
          const crackle = loopSource(s, noise, 0.3);
          crackle.connect(filter("highpass", 2500)).connect(gainNode(0.05)).connect(g);
        }
        g.connect(p).connect(s.amb);
        p.connect(gainNode(0.3)).connect(s.ambWet);
        loc = s.locators[name] = { p, g, boost: 1, on: false };
      }
      if (!loc) return;
      if (pos) setPos(loc.p, pos.x, pos.y ?? 1.2, pos.z);
      loc.on = on;
      loc.g.gain.setTargetAtTime(on ? 0.5 * loc.boost : 0, now(), on ? 0.4 : 0.05);
    },
    // Hint: make an objective's locator easier to hear from afar.
    boostLocator(name, amount) {
      const loc = session?.locators[name];
      if (!loc) return;
      loc.boost = amount;
      if (loc.on) loc.g.gain.setTargetAtTime(0.5 * amount, now(), 1.5);
    },

    // --- discrete sounds ---
    footstep(gait) {
      const peak = gait === "sprint" ? 0.95 : gait === "crouch" ? 0.16 : 0.55;
      const rate = (gait === "sprint" ? 1.08 : gait === "crouch" ? 0.88 : 0.98) * (0.9 + Math.random() * 0.2);
      const lp = (gait === "sprint" ? 3400 : gait === "crouch" ? 1300 : 2300) * (0.85 + Math.random() * 0.3);
      stepSide = -stepSide;
      shot(null, (t, dest) => {
        const pan = ctx.createStereoPanner();
        pan.pan.value = stepSide * 0.12;
        pan.connect(dest);
        if (!sample(t, pan, "step", { rate, peak, lowpass: lp })) {
          burst(t, pan, { buffer: brown, type: "lowpass", freq: lp * 0.4, peak: peak * 0.8, d: 0.12 });
        }
        if (gait === "sprint") tone(t, pan, { f0: 95, f1: 50, peak: 0.12, d: 0.08 });
        return 1;
      }, { wet: 0.06 });
    },
    flashlightClick() {
      shot(null, (t, dest) => {
        if (!sample(t, dest, "click", { peak: 0.7, rate: 0.95 + Math.random() * 0.1 })) {
          burst(t, dest, { freq: 2500, q: 2, peak: 0.4, d: 0.03 });
        }
        return 0.6;
      }, { wet: 0.05 });
    },
    pickup() {
      shot(null, (t, dest) => {
        burst(t, dest, { freq: 1800, q: 1, peak: 0.15, d: 0.05 });
        tone(t + 0.02, dest, { f0: 220, f1: 330, peak: 0.08, d: 0.4 });
        return 0.6;
      }, { wet: 0.2 });
    },
    uiTick() {
      if (ctx.state !== "running" || !session) return;
      shot(null, (t, dest) => (burst(t, dest, { freq: 3000, q: 3, peak: 0.08, d: 0.02 }), 0.2), { wet: 0 });
    },
    panelClunk(pos) {
      shot(pos, (t, dest) => {
        burst(t, dest, { buffer: brown, type: "lowpass", freq: 500, peak: 0.9, d: 0.25 });
        tone(t, dest, { f0: 90, f1: 45, peak: 0.6, d: 0.35 });
        burst(t + 0.05, dest, { freq: 2200, q: 4, peak: 0.25, d: 0.4 });
        return 1;
      }, { wet: 0.4, ref: 2 });
    },
    powerSurge() {
      shot(null, (t, dest) => {
        tone(t, dest, { type: "sawtooth", f0: 40, f1: 240, a: 1.2, peak: 0.08, d: 0.8 });
        burst(t + 1.1, dest, { freq: 3000, q: 0.8, peak: 0.25, d: 0.25 });
        tone(t + 1.1, dest, { f0: 70, f1: 30, peak: 0.5, d: 1.2 });
        return 3;
      }, { bus: "amb", wet: 0.6 });
    },
    tapeTaken(pos) {
      shot(pos, (t, dest) => {
        burst(t, dest, { freq: 1500, q: 3, peak: 0.4, d: 0.05 });
        burst(t + 0.12, dest, { freq: 900, q: 3, peak: 0.3, d: 0.06 });
        tone(t + 0.2, dest, { type: "triangle", f0: 300, f1: 140, a: 0.05, peak: 0.08, d: 1.2 });
        return 2;
      }, { wet: 0.3 });
    },
    doorLocked(pos) {
      shot(pos, (t, dest) => {
        for (let i = 0; i < 4; i++) burst(t + i * 0.07, dest, { freq: 1400 + i * 200, q: 6, peak: 0.35, d: 0.06 });
        tone(t, dest, { f0: 120, f1: 80, peak: 0.25, d: 0.2 });
        return 1;
      }, { wet: 0.35 });
    },
    doorOpened(pos) {
      shot(pos, (t, dest) => {
        tone(t, dest, { f0: 60, f1: 28, a: 0.02, peak: 0.9, d: 2.2 });
        burst(t, dest, { buffer: brown, type: "lowpass", freq: 300, peak: 0.9, d: 1.8 });
        return 3;
      }, { wet: 0.6 });
    },
    knock(pos) {
      shot(pos, (t, dest) => {
        const n = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < n; i++) {
          const ti = t + i * (0.32 + Math.random() * 0.1);
          burst(ti, dest, { buffer: brown, type: "bandpass", freq: 200, q: 1.4, peak: 0.9, d: 0.12 });
          tone(ti, dest, { f0: 85, f1: 55, peak: 0.35, d: 0.1 });
        }
        return 2;
      }, { bus: "amb", wet: 0.55, ref: 2.5 });
    },
    lampPop(pos, loud = 1) {
      shot(pos, (t, dest) => {
        burst(t, dest, { freq: 4000, q: 0.6, peak: 0.6 * loud, a: 0.001, d: 0.04 });
        burst(t + 0.03, dest, { freq: 6000, q: 1, peak: 0.12 * loud, a: 0.01, d: 0.5 });
        return 1;
      }, { bus: "amb", wet: 0.3, ref: 1.5 });
    },
    lampTick(pos) {
      shot(pos, (t, dest) => (burst(t, dest, { freq: 3500, q: 2, peak: 0.1, a: 0.001, d: 0.025 }), 0.3), { bus: "amb", wet: 0.05, ref: 1 });
    },
    metalGroan(pos) {
      shot(pos, (t, dest) => {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.setValueAtTime(70, t);
        o.frequency.linearRampToValueAtTime(52, t + 1.4);
        o.frequency.linearRampToValueAtTime(64, t + 2.6);
        const f = filter("bandpass", 400, 6);
        f.frequency.setValueAtTime(300, t);
        f.frequency.linearRampToValueAtTime(900, t + 2.6);
        const g = gainNode(0);
        env(g, t, 0.6, 0.25, 2.2);
        o.connect(f).connect(g).connect(dest);
        o.start(t);
        o.stop(t + 3);
        return 3;
      }, { bus: "amb", wet: 0.7, ref: 3 });
    },
    creatureStep(pos, speed) {
      shot(pos, (t, dest) => {
        const rate = 0.52 + Math.random() * 0.08;
        const peak = Math.min(1, 0.35 + speed * 0.18);
        if (!sample(t, dest, "step", { rate, peak, lowpass: 800 })) burst(t, dest, { buffer: brown, type: "lowpass", freq: 300, peak, d: 0.2 });
        tone(t, dest, { f0: 60, f1: 35, peak: peak * 0.3, d: 0.15 });
        return 1;
      }, { wet: 0.3, ref: 2.5, rolloff: 1.3 });
    },
    phantomStep(pos) {
      shot(pos, (t, dest) => {
        if (!sample(t, dest, "step", { rate: 0.95 + Math.random() * 0.1, peak: 0.4, lowpass: 2000 })) burst(t, dest, { buffer: brown, type: "lowpass", freq: 700, peak: 0.4, d: 0.12 });
        return 1;
      }, { wet: 0.1, ref: 2 });
    },
    screech(pos, { distant = false } = {}) {
      shot(pos, (t, dest) => {
        const ok = sample(t, dest, "scream", {
          offset: distant ? 5 + Math.random() * 6 : 0.5 + Math.random() * 1.5,
          duration: distant ? 2.5 : 2.2,
          rate: distant ? 0.72 : 1,
          peak: distant ? 0.7 : 0.9,
          lowpass: distant ? 650 : 9000,
          fadeIn: 0.05,
        });
        if (!ok) tone(t, dest, { type: "sawtooth", f0: 900, f1: 300, a: 0.05, peak: 0.25, d: 1.4 });
        return 3;
      }, { wet: distant ? 0.8 : 0.35, ref: distant ? 6 : 2.5, rolloff: distant ? 0.6 : 1.1 });
    },
    stinger() {
      shot(null, (t, dest) => {
        tone(t, dest, { f0: 55, f1: 28, a: 0.01, peak: 0.55, d: 1.8 });
        burst(t, dest, { buffer: pink, freq: 900, q: 0.5, a: 0.4, peak: 0.12, d: 1.2 });
        return 3;
      }, { wet: 0.5 });
    },
    glitch() {
      shot(null, (t, dest) => {
        const o = ctx.createOscillator();
        o.type = "square";
        o.frequency.setValueAtTime(180, t);
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 31;
        const lfoAmt = gainNode(120);
        lfo.connect(lfoAmt).connect(o.frequency);
        const g = gainNode(0);
        env(g, t, 0.01, 0.05, 0.6);
        o.connect(filter("bandpass", 1200, 2)).connect(g).connect(dest);
        burst(t, dest, { freq: 2500, q: 0.4, peak: 0.12, d: 0.6 });
        o.start(t);
        lfo.start(t);
        o.stop(t + 0.7);
        lfo.stop(t + 0.7);
        return 1;
      }, { wet: 0 });
    },
    death() {
      shot(null, (t, dest) => {
        const shaper = ctx.createWaveShaper();
        const curve = new Float32Array(1024);
        for (let i = 0; i < 1024; i++) {
          const x = (i / 1023) * 2 - 1;
          curve[i] = Math.tanh(x * 3);
        }
        shaper.curve = curve;
        shaper.connect(dest);
        if (!sample(t, shaper, "scream", { offset: 2, duration: 2.4, peak: 1, fadeIn: 0.01 })) {
          tone(t, shaper, { type: "sawtooth", f0: 700, f1: 120, a: 0.01, peak: 0.6, d: 2 });
        }
        tone(t, dest, { f0: 70, f1: 25, a: 0.005, peak: 0.9, d: 1.5 });
        burst(t, dest, { buffer: brown, type: "lowpass", freq: 900, a: 0.005, peak: 0.8, d: 0.8 });
        return 3;
      }, { wet: 0.3 });
    },
  };
  return api;
}
