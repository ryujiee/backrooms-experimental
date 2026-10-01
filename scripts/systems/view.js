import * as THREE from "three";
import { patchLampMaterial } from "./lampShader.js";

// First-person presentation: camera placement (interpolated between fixed steps),
// head bob/sway synced to footsteps, trauma-based shake, FOV kick, and the
// flashlight (cookie-textured spot with shadow, hand-held model, faint halo,
// battery, rare instability). "Reduce camera motion" scales all of it down.

export const FLASHLIGHT = {
  drainPerSecond: 100 / 260,
  batteryPickup: 45,
  lowAt: 20,
};

export function createPlayerView({ camera, scene, flashlightModel, textures, quality, lamp }) {
  scene.add(camera);

  const hand = new THREE.Group();
  camera.add(hand);
  const handRest = new THREE.Vector3(0.24, -0.2, -0.44);
  hand.position.copy(handRest);

  const spot = new THREE.SpotLight(0xfff0d6, 0, 28, 0.46, 0.5, 1.5);
  spot.position.set(0, 0, 0);
  spot.target.position.set(0, 0, -1);
  spot.map = textures.cookie;
  spot.shadow.camera.near = 0.2;
  spot.shadow.camera.far = 28;
  spot.shadow.bias = -0.0006;
  spot.shadow.normalBias = 0.02;
  hand.add(spot, spot.target);

  let model;
  if (flashlightModel) {
    model = flashlightModel;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z) || 1;
    model.scale.multiplyScalar(0.24 / longest);
    model.rotation.set(0.08, Math.PI * 1.05, -0.15);
    model.traverse((o) => {
      if (o.isMesh) {
        [].concat(o.material).forEach((m) => m.isMeshStandardMaterial && patchLampMaterial(m, lamp));
        o.castShadow = false;
        o.receiveShadow = false;
        o.frustumCulled = false;
        o.renderOrder = 2;
      }
    });
  } else {
    model = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 0.22, 14), new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.6 }));
    model.rotation.x = Math.PI / 2;
  }
  model.position.set(0, -0.02, 0.1);
  hand.add(model);
  // Weak fill so the held model is readable in total darkness.
  const handFill = new THREE.PointLight(0xffe8c8, 0.25, 1.2, 2);
  handFill.position.set(-0.15, 0.2, 0.2);
  hand.add(handFill);

  // Faint volumetric cone: fades along its length and towards its silhouette, so it
  // never draws hard edges (only reads as dust in the beam).
  const haloMat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 }, uColor: { value: new THREE.Color(0xfff1d0) } },
    vertexShader: /* glsl */ `
      varying float vAlong;
      varying float vFacing;
      void main() {
        vAlong = clamp(-position.z / 3.2, 0.0, 1.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vFacing = abs(dot(n, normalize(-mv.xyz)));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      uniform vec3 uColor;
      varying float vAlong;
      varying float vFacing;
      void main() {
        float a = uOpacity * pow(1.0 - vAlong, 1.6) * smoothstep(0.0, 0.08, vAlong) * pow(vFacing, 3.0);
        gl_FragColor = vec4(uColor * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const haloGeo = new THREE.ConeGeometry(0.75, 3.2, 24, 1, true);
  haloGeo.translate(0, -1.6, 0);
  haloGeo.rotateX(Math.PI / 2);
  const halo = new THREE.Mesh(haloGeo, haloMat);
  halo.position.set(0, 0, -0.08);
  halo.renderOrder = 3;
  halo.frustumCulled = false;
  hand.add(halo);

  let on = false;
  let battery = 100;
  let level = 0;
  let flickerT = 0;
  let nextFlicker = 50 + Math.random() * 60;
  let flicker = 1;
  let toggleKick = 0;
  let trauma = 0;
  let stepParity = 0;
  let lastStride = 0;
  let bobAmp = 0;
  let fovKick = 0;
  const sway = new THREE.Vector2();
  const euler = new THREE.Euler(0, 0, 0, "YXZ");

  function applyQuality(q) {
    spot.castShadow = q.shadows;
    if (q.shadows) {
      spot.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      spot.shadow.map?.dispose();
      spot.shadow.map = null;
    }
  }
  applyQuality(quality);

  return {
    hand,
    spot,
    applyQuality,
    get on() {
      return on;
    },
    get battery() {
      return battery;
    },
    toggle() {
      on = !on;
      toggleKick = 1;
      return on;
    },
    setOn(v) {
      on = v;
    },
    reset() {
      on = false;
      battery = 100;
      level = 0;
      trauma = 0;
      flickerT = 0;
      nextFlicker = 50 + Math.random() * 60;
      spot.intensity = 0;
    },
    addBattery(amount) {
      battery = Math.min(100, battery + amount);
    },
    addTrauma(v) {
      trauma = Math.min(1, trauma + v);
    },
    // Direction the beam points (world space, horizontal component used by the AI).
    getForward(out) {
      return camera.getWorldDirection(out);
    },
    // p: { x, z, prevX, prevZ, alpha, eye, yaw, pitch, state, stridePhase, time, dt, settings, tension, monsterDist, override }
    update(p) {
      const dt = p.dt;
      const motion = p.settings.reduceMotion ? 0.25 : 1;
      const st = p.state;

      // Footstep-synced bob: lowest point on each foot strike.
      if (p.stridePhase < lastStride - 0.5) stepParity ^= 1;
      lastStride = p.stridePhase;
      const targetAmp = st?.moving ? (st.sprinting ? 1.6 : 1) * (1 - st.crouch * 0.5) : 0;
      bobAmp += (targetAmp - bobAmp) * Math.min(1, dt * 6);
      const phase = p.stridePhase * Math.PI * 2;
      const bobY = -Math.cos(phase) * 0.032 * bobAmp * motion;
      const bobX = Math.sin((stepParity + p.stridePhase) * Math.PI) * 0.022 * bobAmp * motion;
      const idle = Math.sin(p.time * 1.7) * 0.006 * (1 - Math.min(1, bobAmp)) * motion;

      // Trauma shake (squared falloff keeps small hits subtle).
      trauma = Math.max(0, trauma - dt * 0.9);
      const shake = trauma * trauma * motion;
      const sx = shake * 0.04 * Math.sin(p.time * 41.3);
      const sy = shake * 0.04 * Math.sin(p.time * 37.7 + 1.3);

      const x = p.prevX + (p.x - p.prevX) * p.alpha;
      const z = p.prevZ + (p.z - p.prevZ) * p.alpha;
      camera.position.set(x + Math.cos(p.yaw) * bobX, p.eye + bobY + idle, z - Math.sin(p.yaw) * bobX);
      const roll = p.settings.reduceMotion ? 0 : bobX * 0.35 + sx * 0.5;
      euler.set(p.pitch + sy, p.yaw + sx, roll);
      if (p.override) euler.set(p.override.pitch, p.override.yaw, p.override.roll ?? 0);
      camera.quaternion.setFromEuler(euler);

      fovKick += ((st?.sprinting ? 5 : 0) * motion - fovKick) * Math.min(1, dt * 4);
      const fov = p.settings.fov + fovKick;
      if (Math.abs(camera.fov - fov) > 0.01) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }

      // Hand sway: lags behind look movement, follows the bob a little.
      sway.x += (-p.mouseDx * 0.0009 - sway.x) * Math.min(1, dt * 10);
      sway.y += (p.mouseDy * 0.0009 - sway.y) * Math.min(1, dt * 10);
      sway.clampScalar(-0.05, 0.05);
      toggleKick = Math.max(0, toggleKick - dt * 5);
      hand.position.set(
        handRest.x + sway.x * motion + bobX * 0.4,
        handRest.y + sway.y * motion + bobY * 0.5 - toggleKick * 0.012 - (p.crouchAmount || 0) * 0.02,
        handRest.z
      );
      hand.rotation.set(-0.04 + toggleKick * 0.05 + sway.y * 0.6, 0.06 + sway.x * 0.8, -0.04 + bobX * 0.6);

      // Battery & instability.
      if (on && p.drainBattery) battery = Math.max(0, battery - FLASHLIGHT.drainPerSecond * dt);
      flickerT -= dt;
      nextFlicker -= dt * (1 + (battery < FLASHLIGHT.lowAt ? 3 : 0) + (p.monsterDist < 12 ? 4 : 0));
      if (nextFlicker <= 0) {
        flickerT = 0.25 + Math.random() * 0.5;
        nextFlicker = 40 + Math.random() * 80;
      }
      flicker = flickerT > 0 ? (Math.random() < 0.55 ? 0.15 : 1) : 1;
      const batteryScale = battery > FLASHLIGHT.lowAt ? 1 : 0.3 + (battery / FLASHLIGHT.lowAt) * 0.7;
      const targetLevel = on ? flicker * batteryScale : 0;
      level += (targetLevel - level) * Math.min(1, dt * (on ? 30 : 40));
      spot.intensity = level * 38;
      haloMat.uniforms.uOpacity.value = level * 0.06;
      halo.visible = level > 0.01;
      return level;
    },
  };
}
