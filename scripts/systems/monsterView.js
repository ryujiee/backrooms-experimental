import * as THREE from "three";
import { patchLampMaterial } from "./lampShader.js";
import { S } from "../game/monster.js";

// The creature GLB ships without a skeleton or clips, so motion is procedural:
// gait bob/roll, lean into speed, breathing, and sharp twitches. Materials get
// the lamp field so it is lit consistently with the corridors it walks through.

const TARGET_HEIGHT = 2.35;

export function createMonsterView({ scene, model, lamp }) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  scene.add(root);
  const owned = [];

  let visual;
  if (model) {
    visual = model;
    visual.rotation.set(0, Math.PI, 0);
    visual.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(visual);
    const size = box.getSize(new THREE.Vector3());
    const scale = TARGET_HEIGHT / (size.y || 1);
    visual.scale.multiplyScalar(scale);
    visual.updateMatrixWorld(true);
    const fitted = new THREE.Box3().setFromObject(visual);
    const center = fitted.getCenter(new THREE.Vector3());
    visual.position.set(-center.x, -fitted.min.y, -center.z);
    visual.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        if (m.isMeshStandardMaterial || m.isMeshLambertMaterial) {
          m.roughness = Math.max(0.55, m.roughness ?? 0.7);
          patchLampMaterial(m, lamp);
        }
      });
    });
  } else {
    const mat = patchLampMaterial(new THREE.MeshStandardMaterial({ color: 0x15130f, roughness: 0.8 }), lamp);
    const geo = new THREE.CapsuleGeometry(0.35, 1.5, 6, 12);
    geo.translate(0, 1.1, 0);
    visual = new THREE.Mesh(geo, mat);
    visual.castShadow = true;
    owned.push(geo, mat);
  }
  body.add(visual);

  let phase = 0;
  let twitch = 0;
  let twitchTarget = new THREE.Euler();
  let nextTwitch = 1;
  let lunge = 0;
  const pos = new THREE.Vector3();

  return {
    root,
    update(dt, monster, alpha, time) {
      const m = monster.m;
      pos.set(m.prev.x + (m.pos.x - m.prev.x) * alpha, 0, m.prev.z + (m.pos.z - m.prev.z) * alpha);
      root.position.copy(pos);
      let dy = m.yaw - root.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      root.rotation.y += dy * Math.min(1, dt * 10);

      const speed = m.speed;
      const hunting = m.state === S.CHASE || m.state === S.ALERT;
      phase += dt * (1.5 + speed * 2.4);
      const gait = Math.min(1, speed / 1.5);
      body.position.y = Math.abs(Math.sin(phase)) * 0.07 * gait;
      body.rotation.z = Math.sin(phase) * 0.07 * gait;
      body.rotation.x = Math.min(0.32, speed * 0.06) + (hunting ? 0.12 : 0);

      // Idle breathing and stillness when watching.
      const breathe = 1 + Math.sin(time * (hunting ? 5 : 1.6)) * 0.018;
      body.scale.set(1, breathe, 1);

      // Sudden twitches: rare when calm, frequent when hunting or staring.
      nextTwitch -= dt * (hunting ? 4 : m.state === S.STALK ? 2.5 : 1);
      if (nextTwitch <= 0) {
        nextTwitch = 1.5 + Math.random() * 4;
        twitch = 1;
        twitchTarget.set((Math.random() - 0.5) * 0.35, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.4);
      }
      twitch = Math.max(0, twitch - dt * 6);
      visual.rotation.x = twitchTarget.x * twitch;
      visual.rotation.z = twitchTarget.z * twitch;
      visual.rotation.y = Math.PI + twitchTarget.y * twitch;
      if (!model) visual.rotation.y = twitchTarget.y * twitch;

      if (m.state === S.ATTACK) lunge = Math.min(1, lunge + dt * 5);
      else lunge = 0;
      body.position.z = lunge * 0.5;
      body.scale.multiplyScalar(1 + lunge * 0.12);
    },
    setVisible(v) {
      root.visible = v;
    },
    // Head height in world space (death camera target).
    headPosition(out) {
      return out.set(root.position.x, TARGET_HEIGHT * 0.8, root.position.z);
    },
    dispose() {
      scene.remove(root);
      owned.forEach((o) => o.dispose());
    },
  };
}
