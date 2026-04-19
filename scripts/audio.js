export function createAudio() {
  let ctx = null;
  let started = false;
  let stepBuffer = null;
  let clickBuffer = null;
  let stepGain = null;
  let clickGain = null;
  let stepArrayBuffer = null;
  let clickArrayBuffer = null;
  let monsterArrayBuffer = null;
  let monsterBuffer = null;
  let monsterSource = null;
  let monsterGain = null;
  let monsterPanner = null;
  let masterGain = null;

  async function preload() {
    const stepPromise = fetch("assets/audio/footstep.ogg")
      .then((res) => res.arrayBuffer())
      .then((buf) => {
        stepArrayBuffer = buf;
      })
      .catch(() => {});

    const clickPromise = fetch("assets/audio/flashlight_click.ogg")
      .then((res) => res.arrayBuffer())
      .then((buf) => {
        clickArrayBuffer = buf;
      })
      .catch(() => {});

    const monsterPromise = fetch("assets/audio/monster_scream.ogg")
      .then((res) => res.arrayBuffer())
      .then((buf) => {
        monsterArrayBuffer = buf;
      })
      .catch(() => {});

    await Promise.allSettled([stepPromise, clickPromise, monsterPromise]);
  }

  function start() {
    if (started) return;
    started = true;
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    masterGain = ctx.createGain();
    masterGain.gain.value = 0.8;
    masterGain.connect(ctx.destination);

    monsterGain = ctx.createGain();
    monsterGain.gain.value = 4.0;

    monsterPanner = ctx.createPanner();
    monsterPanner.panningModel = "HRTF";
    monsterPanner.distanceModel = "inverse";
    monsterPanner.refDistance = 2;
    monsterPanner.maxDistance = 35;
    monsterPanner.rolloffFactor = 1.2;
    monsterPanner.connect(masterGain);
    monsterGain.connect(monsterPanner);

    const oscillator = ctx.createOscillator();
    oscillator.type = "sawtooth";
    oscillator.frequency.value = 50;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 140;

    const gain = ctx.createGain();
    gain.gain.value = 0.02;

    oscillator.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);

    oscillator.start();

    stepGain = ctx.createGain();
    stepGain.gain.value = 0.22;
    stepGain.connect(masterGain);

    loadStepBuffer();
    loadClickBuffer();
    loadMonsterBuffer();
  }

  function resume() {
    if (ctx && ctx.state === "suspended") ctx.resume();
  }

  async function loadStepBuffer() {
    try {
      if (!stepArrayBuffer) {
        const res = await fetch("assets/audio/footstep.ogg");
        stepArrayBuffer = await res.arrayBuffer();
      }
      stepBuffer = await ctx.decodeAudioData(stepArrayBuffer.slice(0));
    } catch {
      stepBuffer = null;
    }
  }

  async function loadClickBuffer() {
    try {
      if (!clickArrayBuffer) {
        const res = await fetch("assets/audio/flashlight_click.ogg");
        clickArrayBuffer = await res.arrayBuffer();
      }
      clickBuffer = await ctx.decodeAudioData(clickArrayBuffer.slice(0));
    } catch {
      clickBuffer = null;
    }
  }

  async function loadMonsterBuffer() {
    try {
      if (!monsterArrayBuffer) {
        const res = await fetch("assets/audio/monster_scream.ogg");
        monsterArrayBuffer = await res.arrayBuffer();
      }
      monsterBuffer = await ctx.decodeAudioData(monsterArrayBuffer.slice(0));
    } catch {
      monsterBuffer = null;
    }
  }

  function playStep(intensity = 1) {
    if (!ctx || !stepBuffer) return;
    const source = ctx.createBufferSource();
    source.buffer = stepBuffer;
    source.playbackRate.value = 0.9 + Math.random() * 0.2;
    const gain = ctx.createGain();
    gain.gain.value = 1.05 * intensity;
    source.connect(gain);
    gain.connect(stepGain);
    source.start();
  }

  function playClick() {
    if (!ctx || !clickBuffer) return;
    const source = ctx.createBufferSource();
    source.buffer = clickBuffer;
    const gain = ctx.createGain();
    gain.gain.value = 0.6;
    source.connect(gain);
    gain.connect(masterGain);
    source.start();
  }

  function playMonsterLoop() {
    if (!ctx) return;
    if (!monsterBuffer) {
      loadMonsterBuffer();
      return;
    }
    if (monsterSource) return;
    const source = ctx.createBufferSource();
    source.buffer = monsterBuffer;
    source.loop = true;
    source.connect(monsterGain);
    source.start();
    monsterSource = source;
  }

  function stopMonsterLoop() {
    if (!monsterSource) return;
    monsterSource.stop();
    monsterSource.disconnect();
    monsterSource = null;
  }

  function setMonsterPosition(position) {
    if (!monsterPanner || !position) return;
    const { x, y, z } = position;
    if (monsterPanner.positionX) {
      monsterPanner.positionX.value = x;
      monsterPanner.positionY.value = y;
      monsterPanner.positionZ.value = z;
    } else {
      monsterPanner.setPosition(x, y, z);
    }
  }

  function setListenerTransform(position, forward, up) {
    if (!ctx) return;
    const listener = ctx.listener;
    if (!listener || !position || !forward || !up) return;
    if (listener.positionX) {
      listener.positionX.value = position.x;
      listener.positionY.value = position.y;
      listener.positionZ.value = position.z;
      listener.forwardX.value = forward.x;
      listener.forwardY.value = forward.y;
      listener.forwardZ.value = forward.z;
      listener.upX.value = up.x;
      listener.upY.value = up.y;
      listener.upZ.value = up.z;
    } else {
      listener.setPosition(position.x, position.y, position.z);
      listener.setOrientation(
        forward.x,
        forward.y,
        forward.z,
        up.x,
        up.y,
        up.z
      );
    }
  }

  function setMasterVolume(value) {
    if (!masterGain) return;
    masterGain.gain.value = Math.max(0, Math.min(1, value));
  }

  function setSfxVolume(value) {
    if (!stepGain) return;
    stepGain.gain.value = 0.22 * Math.max(0, Math.min(1, value));
  }

  return {
    preload,
    start,
    resume,
    playStep,
    playClick,
    playMonsterLoop,
    stopMonsterLoop,
    setMonsterPosition,
    setListenerTransform,
    setMasterVolume,
    setSfxVolume,
  };
}
