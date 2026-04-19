import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createControls } from "./controls.js";
import { createWorld } from "./world.js";
import { createStamina } from "./stamina.js";
import { createMonster } from "./monster.js";
import { createUI } from "./ui.js";
import { createAudio } from "./audio.js";
import { clamp } from "./utils.js";

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.BasicShadowMap;
renderer.physicallyCorrectLights = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0b0b0b, 0.045);

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.1,
  260
);

const rig = new THREE.Object3D();
scene.add(rig);
rig.add(camera);
camera.position.set(0, 1.6, 0);

const ui = createUI();
const audio = createAudio();
ui.bindAudio(audio);

const world = createWorld(scene);
const controls = createControls(camera, renderer.domElement, ui, audio);
ui.bindControls(controls);
const stamina = createStamina();
const monster = createMonster(scene, world);
const listenerForward = new THREE.Vector3();
const listenerUp = new THREE.Vector3(0, 1, 0);

const flashlight = new THREE.SpotLight(0xffffff, 32, 26, Math.PI / 5.2, 0.7, 2);
flashlight.castShadow = true;
flashlight.visible = false;
flashlight.position.set(0, 0, 0);
flashlight.target.position.set(0, 0, -1);
flashlight.shadow.mapSize.width = 256;
flashlight.shadow.mapSize.height = 256;
const flashlightHotspot = new THREE.SpotLight(0xffffff, 55, 20, Math.PI / 16, 0.2, 2);
flashlightHotspot.visible = false;
flashlightHotspot.position.set(0, 0, 0);
flashlightHotspot.target.position.set(0, 0, -1);
const flashlightGroup = new THREE.Group();
flashlightGroup.position.set(0.62, -0.52, -0.78);
camera.add(flashlightGroup);
flashlightGroup.add(flashlight);
flashlightGroup.add(flashlight.target);
flashlightGroup.add(flashlightHotspot);
flashlightGroup.add(flashlightHotspot.target);

const gltfLoader = new GLTFLoader();
const flashlightPromise = new Promise((resolve) => {
  gltfLoader.load(
    "assets/models/old_flashlight.glb",
    (gltf) => {
      const model = gltf.scene;
      model.scale.set(0.1, 0.1, 0.1);
      model.rotation.set(0.08, Math.PI * 1.05, -0.15);
      model.position.set(0, 0, 0);
      flashlightGroup.add(model);
      resolve();
    },
    undefined,
    () => {
      const fallback = new THREE.Mesh(
        new THREE.CylinderGeometry(0.03, 0.03, 0.35, 16),
        new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 })
      );
      fallback.rotation.z = Math.PI / 2;
      flashlightGroup.add(fallback);
      resolve();
    }
  );
});

const haloGeo = new THREE.ConeGeometry(0.6, 2.6, 24, 1, true);
const haloMat = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  transparent: true,
  opacity: 0.08,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
});
const flashlightHalo = new THREE.Mesh(haloGeo, haloMat);
flashlightHalo.rotation.x = -Math.PI / 2;
flashlightHalo.position.set(0, -0.05, -1.4);
flashlightHalo.visible = false;
camera.add(flashlightHalo);

const ambient = new THREE.AmbientLight(0x3a3a2a, 0.32);
scene.add(ambient);

rig.position.set(world.startPosition.x, 0, world.startPosition.z);

let lastTime = performance.now();
let gameOver = false;
let gameWon = false;
let bobTime = 0;
let stepTimer = 0;
let stepKick = 0;
let stepJitter = 0.3;
let lateralSway = 0;
let shakeTime = 0;
let deathFade = 0;
let isPaused = false;
let hasStarted = false;
let vhsStartTime = null;
const vhsTimeEl = document.getElementById("vhsTime");

const assetPromises = [flashlightPromise, audio.preload()].filter(Boolean);
let assetsLoaded = 0;
ui.setLoading(true, `Carregando... 0/${assetPromises.length}`);
assetPromises.forEach((p) =>
  p.finally(() => {
    assetsLoaded += 1;
    ui.setLoading(true, `Carregando... ${assetsLoaded}/${assetPromises.length}`);
    if (assetsLoaded >= assetPromises.length) {
      warmupFlashlight();
      ui.setLoading(false);
    }
  })
);

function warmupFlashlight() {
  const wasVisible = flashlight.visible;
  const wasHot = flashlightHotspot.visible;
  flashlight.visible = true;
  flashlightHotspot.visible = true;
  renderer.compile(scene, camera);
  renderer.render(scene, camera);
  flashlight.visible = wasVisible;
  flashlightHotspot.visible = wasHot;
}

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", resize);

function update(delta) {
  if (!controls.isLocked()) return;

  const move = controls.getMoveVector();
  const isMoving = move.lengthSq() > 0.0001;
  const isSprinting = controls.isSprinting();

  const staminaState = stamina.update(delta, isMoving, isSprinting);
  ui.setStamina(staminaState.value, staminaState.max);

  const effectiveSprint = isSprinting && staminaState.canSprint;
  const speed = isMoving ? (effectiveSprint ? 4.6 : 2.8) : 0;

  const desired = move.normalize().multiplyScalar(speed * delta);
  const next = world.tryMove(rig.position, desired, controls.getYaw());
  rig.position.copy(next);

  const bobSpeed = isMoving ? (effectiveSprint ? 12 : 7) : 0.8;
  bobTime += delta * bobSpeed;

  const bobAmount = isMoving ? (effectiveSprint ? 0.055 : 0.032) : 0.012;
  const baseBob = Math.sin(bobTime) * bobAmount;

  const stepInterval = (effectiveSprint ? 0.32 : 0.45) + stepJitter;
  if (isMoving) {
    stepTimer += delta;
    if (stepTimer >= stepInterval) {
      stepTimer = 0;
      stepKick = 1;
      stepJitter = (Math.random() - 0.5) * 0.08;
      const intensity = effectiveSprint ? 1.2 : 0.8;
      audio.playStep(intensity);
      lateralSway = (Math.random() - 0.5) * (effectiveSprint ? 0.06 : 0.04);
    }
  } else {
    stepTimer = 0;
  }

  if (stepKick > 0) {
    stepKick = Math.max(0, stepKick - delta * 6);
  }

  const kick = stepKick * (effectiveSprint ? 0.032 : 0.02);
  lateralSway *= 1 - Math.min(1, delta * 6);

  const threat = clamp(monster.getThreatLevel(rig.position), 0, 1);

  camera.position.y = 1.6 + baseBob - kick;
  camera.position.x = lateralSway * 0.08;
  const shake = shakeTime > 0 ? Math.sin(shakeTime * 22) * 0.01 * (threat * 1.2) : 0;
  camera.rotation.z =
    Math.sin(bobTime * 0.6) * 0.012 + kick * 0.3 + lateralSway * 0.2 + shake;
  camera.rotation.x += shake * 0.6;

  flashlightGroup.position.y = -0.52 + baseBob * 0.5 - kick * 0.5;
  flashlightGroup.position.x = 0.62 + lateralSway * 0.25;
  flashlightGroup.position.z = -0.78;
  flashlightGroup.rotation.z = -0.25 + lateralSway * 0.4;
  flashlightGroup.rotation.x = -0.12 + kick * 0.6;
  flashlightGroup.rotation.y = 0.1;

  const flashlightOn = controls.isFlashlightOn();
  flashlight.visible = flashlightOn;
  flashlightHotspot.visible = flashlightOn;
  flashlightHalo.visible = flashlightOn;
  flashlight.position.set(0, 0, 0);
  flashlightHotspot.position.set(0, 0, 0);
  flashlight.target.position.set(0, 0, -1);
  flashlightHotspot.target.position.set(0, 0, -1);

  world.updateLights(delta);
  monster.update(delta, rig.position, flashlight.visible, audio);
  camera.getWorldDirection(listenerForward);
  audio.setListenerTransform(rig.position, listenerForward, listenerUp);
  audio.setMonsterPosition(monster.getPosition());

  if (threat > 0.65) {
    shakeTime += delta * (threat * 10);
  } else {
    shakeTime = Math.max(0, shakeTime - delta * 2);
  }

  if (!gameOver && monster.isPlayerCaught(rig.position)) {
    gameOver = true;
    ui.showGameOver();
    controls.unlock();
    deathFade = 0.0001;
  }

  if (!gameWon && world.isAtExit(rig.position)) {
    gameWon = true;
    ui.showMessage("VOCE ENCONTROU A SAIDA");
    controls.unlock();
  }

  ui.setStress(threat);

  if (deathFade > 0) {
    deathFade = Math.min(1, deathFade + delta * 0.8);
  }

  flashlightHalo.position.set(0, -0.05, -1.4);

  if (deathFade > 0) {
    const intensity = Math.min(0.9, 0.2 + deathFade * 0.8);
    document.body.style.filter = `saturate(70%) hue-rotate(-8deg) brightness(90%) sepia(20%)`;
    document.body.style.background = `rgba(80, 0, 0, ${intensity})`;
  }
}

function animate() {
  const now = performance.now();
  const delta = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (vhsTimeEl && vhsStartTime) {
    const elapsed = Math.floor((now - vhsStartTime) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2, "0");
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
    const s = String(elapsed % 60).padStart(2, "0");
    vhsTimeEl.textContent = `${h}:${m}:${s}`;
  }

  update(delta);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

ui.onStart(() => {
  controls.lock();
  audio.start();
  ui.hideOverlay();
  hasStarted = true;
  vhsStartTime = performance.now();
});

ui.onExit(() => {
  window.location.reload();
});

ui.onRestart(() => {
  window.location.reload();
});

ui.onMenu(() => {
  ui.showMainMenu();
  isPaused = false;
});

ui.onContinue(() => {
  if (!hasStarted) return;
  ui.hidePause();
  controls.lock();
  isPaused = false;
});

ui.onPauseMenu(() => {
  ui.showMainMenu();
  isPaused = false;
});

document.addEventListener("keydown", (e) => {
  if (e.code !== "Escape") return;
  if (!hasStarted || gameOver) return;
  if (isPaused) {
    ui.hidePause();
    controls.lock();
    isPaused = false;
  } else {
    controls.unlock();
    ui.showPause();
    isPaused = true;
  }
});

animate();
