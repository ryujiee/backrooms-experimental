// Keyboard / mouse / pointer-lock. Listeners are attached once for the lifetime
// of the page (never per run). Keys are cleared on blur so alt-tab never leaves
// the player walking on their own.

const PREVENT = new Set(["Tab", "Space", "F3", "KeyF"]);

export function createInput(canvas) {
  const down = new Set();
  const pressed = new Set();
  let mouseX = 0;
  let mouseY = 0;
  const lockListeners = [];
  const keyListeners = [];
  // Automated QA can drive the game without a real pointer lock.
  let virtualLock = false;

  const isLocked = () => virtualLock || document.pointerLockElement === canvas;

  function clear() {
    down.clear();
    pressed.clear();
    mouseX = mouseY = 0;
  }

  window.addEventListener("keydown", (e) => {
    if (PREVENT.has(e.code) && isLocked()) e.preventDefault();
    if (e.code === "Tab") e.preventDefault();
    if (e.repeat) return;
    down.add(e.code);
    pressed.add(e.code);
    keyListeners.forEach((fn) => fn(e.code, e));
  });
  window.addEventListener("keyup", (e) => down.delete(e.code));
  window.addEventListener("blur", clear);
  document.addEventListener("visibilitychange", () => document.hidden && clear());

  document.addEventListener("mousemove", (e) => {
    if (!isLocked()) return;
    // Some browsers report a huge spike right after locking; ignore absurd deltas.
    if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
    mouseX += e.movementX;
    mouseY += e.movementY;
  });
  document.addEventListener("mousedown", (e) => {
    if (!isLocked()) return;
    const code = e.button === 0 ? "Mouse0" : e.button === 2 ? "Mouse2" : `Mouse${e.button}`;
    down.add(code);
    pressed.add(code);
  });
  document.addEventListener("mouseup", (e) => down.delete(e.button === 0 ? "Mouse0" : e.button === 2 ? "Mouse2" : `Mouse${e.button}`));
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  document.addEventListener("pointerlockchange", () => {
    if (!isLocked()) clear();
    lockListeners.forEach((fn) => fn(isLocked()));
  });
  document.addEventListener("pointerlockerror", () => lockListeners.forEach((fn) => fn(false, true)));

  // Resolves from the pointerlockchange / pointerlockerror events, not from the
  // return value of requestPointerLock (a promise only in some browsers).
  function lock() {
    if (virtualLock || isLocked()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        document.removeEventListener("pointerlockchange", onChange);
        document.removeEventListener("pointerlockerror", onError);
        clearTimeout(timer);
        resolve(value);
      };
      const onChange = () => isLocked() && finish(true);
      const onError = () => finish(false);
      document.addEventListener("pointerlockchange", onChange);
      document.addEventListener("pointerlockerror", onError);
      const timer = setTimeout(() => finish(isLocked()), 1500);
      try {
        const r = canvas.requestPointerLock();
        if (r && typeof r.catch === "function") r.catch(() => finish(false));
      } catch {
        finish(false);
      }
    });
  }

  return {
    isLocked,
    lock,
    unlock() {
      if (document.pointerLockElement) document.exitPointerLock();
      if (virtualLock) {
        virtualLock = false;
        lockListeners.forEach((fn) => fn(false));
      }
    },
    setVirtualLock(on) {
      virtualLock = on;
      lockListeners.forEach((fn) => fn(isLocked()));
    },
    onLockChange(fn) {
      lockListeners.push(fn);
    },
    onKey(fn) {
      keyListeners.push(fn);
    },
    isDown: (code) => down.has(code),
    // Edge-triggered: true once per physical press.
    consumePress(code) {
      if (!pressed.has(code)) return false;
      pressed.delete(code);
      return true;
    },
    endFrame() {
      pressed.clear();
    },
    consumeMouse() {
      const out = { dx: mouseX, dy: mouseY };
      mouseX = mouseY = 0;
      return out;
    },
    // QA hook: inject keys.
    setKey(code, on) {
      if (on) {
        if (!down.has(code)) pressed.add(code);
        down.add(code);
      } else down.delete(code);
    },
    clear,
  };
}
