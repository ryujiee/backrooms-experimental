import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.152.2/build/three.module.js";

export function createControls(camera, domElement, ui, audio) {
  const keys = new Set();
  let flashlightOn = false;
  let yaw = 0;
  let pitch = 0;
  let sensitivity = 0.0024;

  function lock() {
    domElement.requestPointerLock();
  }

  function unlock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  function isLocked() {
    return document.pointerLockElement === domElement;
  }

  document.addEventListener("keydown", (e) => {
    keys.add(e.code);
    if (e.code === "KeyF") {
      flashlightOn = !flashlightOn;
      audio.playClick();
    }
  });

  document.addEventListener("keyup", (e) => keys.delete(e.code));

  document.addEventListener("mousemove", (e) => {
    if (!isLocked()) return;
    yaw -= e.movementX * sensitivity;
    pitch -= e.movementY * sensitivity;
    pitch = Math.max(-1.45, Math.min(1.45, pitch));
    camera.rotation.set(pitch, yaw, 0, "YXZ");
  });

  document.addEventListener("pointerlockchange", () => {
    if (!isLocked()) ui.showOverlay();
  });

  domElement.addEventListener("click", () => {
    if (!isLocked()) {
      lock();
      audio.resume();
    }
  });

  function getMoveVector() {
    const dir = new THREE.Vector3();
    if (keys.has("KeyW")) dir.z += 1;
    if (keys.has("KeyS")) dir.z -= 1;
    if (keys.has("KeyA")) dir.x -= 1;
    if (keys.has("KeyD")) dir.x += 1;
    return dir;
  }

  function getYaw() {
    return yaw;
  }

  function isSprinting() {
    return keys.has("ShiftLeft") || keys.has("ShiftRight");
  }

  function isFlashlightOn() {
    return flashlightOn;
  }

  function setSensitivity(value) {
    sensitivity = Math.max(0.0006, Math.min(0.006, value));
  }

  return {
    lock,
    unlock,
    isLocked,
    getMoveVector,
    getYaw,
    isSprinting,
    isFlashlightOn,
    setSensitivity,
  };
}
