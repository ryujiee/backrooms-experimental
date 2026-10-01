import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { CELL, WALL_HEIGHT, WALL_THICKNESS, PILLAR_SIZE, cellCenter, cornerWorld, hasWall } from "../game/grid.js";
import { propTransform, objectiveTransforms, batteryTransform, wallFrame, PROP_SIZE } from "../game/placement.js";
import { patchLampMaterial } from "./lampShader.js";
import { createStaticScreen } from "./textures.js";

// Builds the renderable world from a generated map:
// - static geometry merged per 12x12-cell chunk (floor / ceiling / walls) => ~27 draw calls
// - instanced lamp fixtures, props, batteries, fake doors
// - a small pool of real PointLights that follows the flickering lamps near the player
// - objective set pieces (panel, TV + tape, exit door + light chamber)

const CHUNK = 12;
const H = WALL_HEIGHT;
const T = WALL_THICKNESS;
const LAMP_Y = H - 0.03;

// --- geometry helpers --------------------------------------------------------

function createBuilder() {
  const pos = [];
  const nrm = [];
  const uv = [];
  const idx = [];
  // Quad from origin along `right` (w) and `up` (h); normal = right x up. uvFn(worldPoint) -> [u, v].
  function face(o, right, up, w, h, uvFn) {
    const n = new THREE.Vector3().crossVectors(right, up).normalize();
    const base = pos.length / 3;
    const corners = [
      o.clone(),
      o.clone().addScaledVector(right, w),
      o.clone().addScaledVector(right, w).addScaledVector(up, h),
      o.clone().addScaledVector(up, h),
    ];
    for (const c of corners) {
      pos.push(c.x, c.y, c.z);
      nrm.push(n.x, n.y, n.z);
      const [u, v] = uvFn(c);
      uv.push(u, v);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  function build() {
    if (!pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
  return { face, build };
}

const RIGHT = {
  nz: new THREE.Vector3(-1, 0, 0),
  pz: new THREE.Vector3(1, 0, 0),
  nx: new THREE.Vector3(0, 0, 1),
  px: new THREE.Vector3(0, 0, -1),
};
const UP = new THREE.Vector3(0, 1, 0);
const wallUV = (axis, sign) => (p) => [(sign * (axis === "x" ? p.x : p.z)) / 1.5, p.y / H];

// Vertical box sides (no top/bottom). skip: { nz, pz, nx, px } to omit hidden faces.
function addBox(b, minX, minZ, maxX, maxZ, y0, y1, skip = {}) {
  const h = y1 - y0;
  if (!skip.nz) b.face(new THREE.Vector3(maxX, y0, minZ), RIGHT.nz, UP, maxX - minX, h, wallUV("x", -1));
  if (!skip.pz) b.face(new THREE.Vector3(minX, y0, maxZ), RIGHT.pz, UP, maxX - minX, h, wallUV("x", 1));
  if (!skip.nx) b.face(new THREE.Vector3(minX, y0, minZ), RIGHT.nx, UP, maxZ - minZ, h, wallUV("z", 1));
  if (!skip.px) b.face(new THREE.Vector3(maxX, y0, maxZ), RIGHT.px, UP, maxZ - minZ, h, wallUV("z", -1));
}

function boxGeo(w, h, d, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

// Deterministic per-instance jitter.
function hash01(i, salt = 0) {
  let x = Math.imul(i ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul(salt + 7, 0x9e3779b1);
  x ^= x >>> 15;
  x = Math.imul(x, 0x2c1b3c6d);
  x ^= x >>> 12;
  return (x >>> 0) / 4294967296;
}

function flickerValue(phase, t) {
  const slow = hash01(Math.floor((t + phase) * 0.7), 3);
  if (slow < 0.22) return hash01(Math.floor((t + phase) * 18), 5) < 0.12 ? 0.8 : 0.03;
  const fast = hash01(Math.floor((t + phase) * 14), 9);
  if (fast < 0.08) return 0.05;
  if (fast < 0.16) return 0.55;
  return 0.94 + 0.06 * Math.sin((t + phase) * 97);
}

export const LAMP = { OFF: 0, ON: 1, FLICKER: 2 };

// Materials are created once per page and shared by every run, so restarting never
// recompiles shaders (per-frame colour tweaks are re-applied by each run's update).
export function createWorldMaterials(textures, lamp) {
  const mat = {
    wall: patchLampMaterial(new THREE.MeshStandardMaterial({ map: textures.wall, roughness: 0.92 }), lamp, { macro: true }),
    pillar: patchLampMaterial(new THREE.MeshStandardMaterial({ map: textures.wall, roughness: 0.92, color: 0xd9d2b8 }), lamp, { macro: true }),
    concrete: patchLampMaterial(new THREE.MeshStandardMaterial({ color: 0x8d8a80, roughness: 0.95 }), lamp, { macro: true }),
    floor: patchLampMaterial(new THREE.MeshStandardMaterial({ map: textures.carpet, roughness: 1 }), lamp, { macro: true }),
    ceiling: patchLampMaterial(new THREE.MeshStandardMaterial({ map: textures.ceiling, roughness: 0.95 }), lamp, { macro: true }),
    decal: patchLampMaterial(
      new THREE.MeshStandardMaterial({
        map: textures.decals,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
        roughness: 1,
      }),
      lamp
    ),
    lampFixture: new THREE.MeshBasicMaterial({ map: textures.lamp }),
    chair: patchLampMaterial(new THREE.MeshStandardMaterial({ color: 0x3c4148, roughness: 0.85 }), lamp),
    desk: patchLampMaterial(new THREE.MeshStandardMaterial({ color: 0x7d6c4f, roughness: 0.7 }), lamp),
    box: patchLampMaterial(new THREE.MeshStandardMaterial({ map: textures.cardboard, roughness: 0.95 }), lamp),
    wetSign: patchLampMaterial(new THREE.MeshStandardMaterial({ map: textures.wetSign, side: THREE.DoubleSide, roughness: 0.6 }), lamp),
    woodDoor: patchLampMaterial(new THREE.MeshStandardMaterial({ map: textures.woodDoor, roughness: 0.8 }), lamp),
    metalDoor: patchLampMaterial(new THREE.MeshStandardMaterial({ map: textures.metalDoor, roughness: 0.55, metalness: 0.3 }), lamp),
    darkMetal: patchLampMaterial(new THREE.MeshStandardMaterial({ color: 0x2b2b28, roughness: 0.6, metalness: 0.4 }), lamp),
    panel: patchLampMaterial(new THREE.MeshStandardMaterial({ map: textures.panel, roughness: 0.55, metalness: 0.35 }), lamp),
    plastic: patchLampMaterial(new THREE.MeshStandardMaterial({ color: 0x1d1d1b, roughness: 0.5 }), lamp),
    tape: patchLampMaterial(new THREE.MeshStandardMaterial({ map: textures.tapeLabel, roughness: 0.4, emissive: 0x111111 }), lamp),
    battery: patchLampMaterial(new THREE.MeshStandardMaterial({ color: 0xd8b13a, roughness: 0.35, metalness: 0.5, emissive: 0x3a2c05 }), lamp),
    sign: new THREE.MeshBasicMaterial({ map: textures.exitSign, color: 0x221111 }),
    chamber: new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 3.1, 2.9), side: THREE.BackSide, fog: false }),
    ledRed: new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.1, 0.05) }),
    ledGreen: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 3, 0.3) }),
    redLamp: new THREE.MeshBasicMaterial({ color: 0x220505 }),
  };
  mat.decal.customProgramCacheKey = () => "lamp-decal";
  return mat;
}

export function createWorld({ scene, map, collision, lightField, lamp, textures, quality, rng, exitBoxes, materials }) {
  const g = map.grid;
  const root = new THREE.Group();
  root.name = "world";
  scene.add(root);
  const disposables = [];
  const track = (x) => (disposables.push(x), x);

  const mat = materials;

  // --- static chunks -----------------------------------------------------------
  const chunks = new Map();
  const chunkOf = (cx, cy) => {
    const key = `${Math.floor(cx / CHUNK)},${Math.floor(cy / CHUNK)}`;
    if (!chunks.has(key)) chunks.set(key, { floor: createBuilder(), ceiling: createBuilder(), wall: createBuilder(), pillar: createBuilder(), concrete: createBuilder() });
    return chunks.get(key);
  };
  const openSide = (x, y) => x >= 0 && y >= 0 && x < g.w && y < g.h && !g.solid[y * g.w + x];

  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      if (g.solid[y * g.w + x]) continue;
      const c = cornerWorld(g, x, y);
      const ch = chunkOf(x, y);
      ch.floor.face(new THREE.Vector3(c.x, 0, c.z + CELL), RIGHT.pz, new THREE.Vector3(0, 0, -1), CELL, CELL, (p) => [p.x / 2, -p.z / 2]);
      ch.ceiling.face(new THREE.Vector3(c.x, H, c.z), RIGHT.pz, new THREE.Vector3(0, 0, 1), CELL, CELL, (p) => [p.x / 2.4, p.z / 2.4]);
    }
  }

  // Horizontal wall runs (merged so collinear segments never z-fight).
  for (let y = 0; y <= g.h; y++) {
    let start = -1;
    for (let x = 0; x <= g.w; x++) {
      const on = x < g.w && g.hWall[y * g.w + x] === 1 && (openSide(x, y - 1) || openSide(x, y));
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        const a = cornerWorld(g, start, y);
        const b = cornerWorld(g, x, y);
        addBox(chunkOf(start, Math.min(y, g.h - 1)).wall, a.x - T / 2, a.z - T / 2, b.x + T / 2, a.z + T / 2, 0, H, { nz: y === 0, pz: y === g.h });
        start = -1;
      }
    }
  }
  for (let x = 0; x <= g.w; x++) {
    let start = -1;
    for (let y = 0; y <= g.h; y++) {
      const on = y < g.h && g.vWall[y * (g.w + 1) + x] === 1 && (openSide(x - 1, y) || openSide(x, y));
      if (on && start < 0) start = y;
      if (!on && start >= 0) {
        const a = cornerWorld(g, x, start);
        const b = cornerWorld(g, x, y);
        addBox(chunkOf(Math.min(x, g.w - 1), start).wall, a.x - T / 2, a.z - T / 2, a.x + T / 2, b.z + T / 2, 0, H, { nx: x === 0, px: x === g.w });
        start = -1;
      }
    }
  }
  const s = PILLAR_SIZE / 2;
  for (let j = 0; j <= g.h; j++) {
    for (let i = 0; i <= g.w; i++) {
      if (!g.pillar[j * (g.w + 1) + i]) continue;
      const c = cornerWorld(g, i, j);
      const ch = chunkOf(Math.min(i, g.w - 1), Math.min(j, g.h - 1));
      addBox(hash01(j * 97 + i, 1) < 0.12 ? ch.concrete : ch.pillar, c.x - s, c.z - s, c.x + s, c.z + s, 0, H);
    }
  }

  const staticMeshes = [];
  for (const ch of chunks.values()) {
    for (const [key, material] of [
      ["floor", mat.floor],
      ["ceiling", mat.ceiling],
      ["wall", mat.wall],
      ["pillar", mat.pillar],
      ["concrete", mat.concrete],
    ]) {
      const geo = ch[key].build();
      if (!geo) continue;
      track(geo);
      const mesh = new THREE.Mesh(geo, material);
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = key === "wall" || key === "pillar" || key === "concrete";
      mesh.receiveShadow = true;
      root.add(mesh);
      staticMeshes.push(mesh);
    }
  }

  // --- decals (one merged mesh) ------------------------------------------------
  const decalB = createBuilder();
  const atlasUV = (col, row) => (u, v) => [(col + u) / 4, 1 - (row + 1 - v) / 4];
  function decalQuad(cx, cy, cz, right, up, w, h, col, row) {
    const o = new THREE.Vector3(cx, cy, cz).addScaledVector(right, -w / 2).addScaledVector(up, -h / 2);
    const uvf = atlasUV(col, row);
    const inv = (p) => {
      const d = p.clone().sub(o);
      return uvf(d.dot(right) / w, d.dot(up) / h);
    };
    decalB.face(o, right, up, w, h, inv);
  }
  const ceilingHoles = [];
  for (const p of map.props) {
    const t = propTransform(g, p);
    const right = new THREE.Vector3(Math.cos(t.yaw), 0, -Math.sin(t.yaw));
    const wallOffset = 0.012;
    const nx = Math.sin(t.yaw);
    const nz = Math.cos(t.yaw);
    if (p.type === "wallStain") {
      decalQuad(t.x + nx * wallOffset, 0.4 + hash01(p.index, p.dir) * 1.2, t.z + nz * wallOffset, right, UP, 1.3, 1.3, p.variant, 0);
    } else if (p.type === "scribble") {
      decalQuad(t.x + nx * wallOffset, 1.35, t.z + nz * wallOffset, right, UP, 0.8, 0.8, p.variant, 2);
    } else if (p.type === "vent") {
      decalQuad(t.x + nx * wallOffset, 2.4, t.z + nz * wallOffset, right, UP, 0.7, 0.7, 1, 3);
    } else if (p.type === "floorStain") {
      // In-plane axes chosen so right x up = +Y (faces the camera from above).
      const r = new THREE.Vector3(Math.cos(t.yaw), 0, Math.sin(t.yaw));
      const upDir = new THREE.Vector3(Math.sin(t.yaw), 0, -Math.cos(t.yaw));
      decalQuad(t.x, 0.006, t.z, r, upDir, 1.7, 1.7, p.variant, 1);
    } else if (p.type === "fallenTile") {
      const c = cellCenter(g, p.x, p.y);
      ceilingHoles.push({ x: c.x + 0.3, z: c.z - 0.3 });
      decalQuad(c.x + 0.3, H - 0.006, c.z - 0.3, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), 0.6, 0.6, 0, 3);
    }
  }
  const decalGeo = decalB.build();
  if (decalGeo) {
    track(decalGeo);
    const decals = new THREE.Mesh(decalGeo, mat.decal);
    decals.matrixAutoUpdate = false;
    decals.renderOrder = 1;
    root.add(decals);
  }

  // --- instanced props ---------------------------------------------------------
  const tmpObj = new THREE.Object3D();
  function instanced(geo, material, count, { shadow = true } = {}) {
    track(geo);
    const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, count));
    mesh.count = 0;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  }
  function pushInstance(mesh, x, y, z, yaw, scale = 1, extraRot = null) {
    tmpObj.position.set(x, y, z);
    tmpObj.rotation.set(extraRot?.x || 0, yaw, extraRot?.z || 0);
    tmpObj.scale.setScalar(scale);
    tmpObj.updateMatrix();
    mesh.setMatrixAt(mesh.count, tmpObj.matrix);
    mesh.count++;
    mesh.instanceMatrix.needsUpdate = true;
    return mesh.count - 1;
  }

  const byType = (type) => map.props.filter((p) => p.type === type);
  const chairGeo = mergeGeometries([
    boxGeo(0.46, 0.06, 0.46, 0, 0.46, 0),
    boxGeo(0.46, 0.5, 0.05, 0, 0.76, -0.21),
    boxGeo(0.04, 0.46, 0.04, -0.2, 0.23, -0.2),
    boxGeo(0.04, 0.46, 0.04, 0.2, 0.23, -0.2),
    boxGeo(0.04, 0.46, 0.04, -0.2, 0.23, 0.2),
    boxGeo(0.04, 0.46, 0.04, 0.2, 0.23, 0.2),
  ]);
  const chairs = instanced(chairGeo, mat.chair, byType("chair").length);
  const chairIndex = new Map();
  for (const p of byType("chair")) {
    const t = propTransform(g, p);
    chairIndex.set(p, pushInstance(chairs, t.x, 0, t.z, t.yaw));
  }

  const deskGeo = mergeGeometries([
    boxGeo(1.5, 0.05, 0.76, 0, 0.74, 0),
    boxGeo(0.05, 0.72, 0.7, -0.7, 0.36, 0),
    boxGeo(0.05, 0.72, 0.7, 0.7, 0.36, 0),
    boxGeo(1.4, 0.42, 0.03, 0, 0.45, -0.34),
    boxGeo(0.4, 0.5, 0.62, 0.45, 0.45, 0.02),
  ]);
  const desks = instanced(deskGeo, mat.desk, byType("desk").length);
  for (const p of byType("desk")) {
    const t = propTransform(g, p);
    pushInstance(desks, t.x, 0, t.z, t.yaw);
  }

  const boxes = instanced(boxGeo(0.5, 0.38, 0.42, 0, 0.19, 0), mat.box, byType("boxes").length * 3);
  for (const p of byType("boxes")) {
    const t = propTransform(g, p);
    const n = 2 + Math.floor(hash01(p.index, 2) * 2);
    for (let k = 0; k < n; k++) {
      const ox = (hash01(p.index, 10 + k) - 0.5) * 0.3;
      const oz = (hash01(p.index, 20 + k) - 0.5) * 0.3;
      pushInstance(boxes, t.x + ox, k * 0.38, t.z + oz, t.yaw + (hash01(p.index, 30 + k) - 0.5) * 0.5);
    }
  }

  const signGeo = mergeGeometries([
    (() => {
      const q = new THREE.PlaneGeometry(0.32, 0.62);
      q.rotateX(-0.25);
      q.translate(0, 0.3, 0.08);
      return q;
    })(),
    (() => {
      const q = new THREE.PlaneGeometry(0.32, 0.62);
      q.rotateY(Math.PI);
      q.rotateX(0.25);
      q.translate(0, 0.3, -0.08);
      return q;
    })(),
  ]);
  const wetSigns = instanced(signGeo, mat.wetSign, byType("wetSign").length);
  for (const p of byType("wetSign")) {
    const t = propTransform(g, p);
    pushInstance(wetSigns, t.x, 0, t.z, t.yaw);
  }

  const tiles = instanced(boxGeo(0.6, 0.02, 0.6, 0, 0.01, 0), mat.ceiling, byType("fallenTile").length);
  ceilingHoles.forEach((h, k) => pushInstance(tiles, h.x + 0.5 * Math.cos(k), 0.01, h.z + 0.5 * Math.sin(k), k * 1.3, 1, { x: 0.12, z: -0.05 }));

  const fakeDoorGeo = mergeGeometries([boxGeo(1.05, 2.15, 0.05, 0, 1.075, 0.025)]);
  const fakeDoors = instanced(fakeDoorGeo, mat.woodDoor, byType("fakeDoor").length + 1, { shadow: false });
  for (const p of byType("fakeDoor")) {
    const t = propTransform(g, p);
    pushInstance(fakeDoors, t.x, 0, t.z, t.yaw);
  }

  // --- lamps -------------------------------------------------------------------
  const lampGeo = boxGeo(1.2, 0.04, 0.6, 0, 0, 0);
  const lampMesh = instanced(lampGeo, mat.lampFixture, map.lamps.length, { shadow: false });
  lampMesh.receiveShadow = false;
  const lampColors = new Float32Array(map.lamps.length * 3);
  lampMesh.instanceColor = new THREE.InstancedBufferAttribute(lampColors, 3);
  const lampPos = map.lamps.map((l) => cellCenter(g, l.x, l.y));
  const lampTint = map.lamps.map((l, i) => 0.85 + hash01(i, 4) * 0.25);
  map.lamps.forEach((l, i) => pushInstance(lampMesh, lampPos[i].x, LAMP_Y, lampPos[i].z, l.axis === "x" ? 0 : Math.PI / 2));

  const lampState = new Uint8Array(map.lamps.length);
  const lampOverride = new Float32Array(map.lamps.length).fill(-1); // temporary dims (events)
  const flickering = new Set();
  function setLamp(i, state) {
    lampState[i] = state;
    if (state === LAMP.FLICKER) flickering.add(i);
    else flickering.delete(i);
    const lit = state === LAMP.ON && lampOverride[i] < 0 ? 1 : state === LAMP.ON ? lampOverride[i] : 0;
    lightField.setLampLevel(i, lit);
    writeLampColor(i, state === LAMP.ON ? (lampOverride[i] >= 0 ? lampOverride[i] : 1) : state === LAMP.FLICKER ? 0.6 : 0);
  }
  function writeLampColor(i, level) {
    const red = map.lamps[i].kind === "red";
    const k = lampTint[i];
    const v = 0.07 + level * 2.3 * k;
    lampColors[i * 3] = red ? 0.07 + level * 3 : v;
    lampColors[i * 3 + 1] = red ? 0.03 + level * 0.35 : v * 0.98;
    lampColors[i * 3 + 2] = red ? 0.03 + level * 0.3 : v * 0.9;
    lampMesh.instanceColor.needsUpdate = true;
  }
  map.lamps.forEach((l, i) => setLamp(i, l.kind === "off" ? LAMP.OFF : l.kind === "flicker" ? LAMP.FLICKER : LAMP.ON));

  // Pool of real lights for flickering lamps near the player.
  const pool = [];
  for (let k = 0; k < quality.poolLights; k++) {
    const light = new THREE.PointLight(0xfff2d6, 0, 9, 1.6);
    light.userData.lamp = -1;
    root.add(light);
    pool.push(light);
  }
  let poolTimer = 0;
  let lastTickAt = 0;
  const lampTicks = [];

  // --- objectives --------------------------------------------------------------
  const ot = objectiveTransforms(map);
  const placeFrame = (obj, f, y = 0) => {
    obj.position.set(f.x, y, f.z);
    obj.rotation.y = f.yaw;
    root.add(obj);
    return obj;
  };

  // Electrical panel.
  const panel = new THREE.Group();
  const panelBody = new THREE.Mesh(track(boxGeo(0.62, 0.82, 0.16, 0, 0, 0.08)), mat.darkMetal);
  const panelFace = new THREE.Mesh(track(new THREE.PlaneGeometry(0.58, 0.78)), mat.panel);
  panelFace.position.z = 0.162;
  const lever = new THREE.Mesh(track(boxGeo(0.05, 0.22, 0.05, 0, 0.1, 0)), mat.plastic);
  lever.position.set(0.18, -0.12, 0.2);
  lever.rotation.x = 2.4;
  const leds = [0, 1, 2].map((k) => {
    const led = new THREE.Mesh(track(boxGeo(0.035, 0.035, 0.02)), mat.ledRed);
    led.position.set(-0.16 + k * 0.08, -0.2, 0.17);
    panel.add(led);
    return led;
  });
  panel.add(panelBody, panelFace, lever);
  panelBody.castShadow = true;
  placeFrame(panel, ot.panel, 1.35);

  // TV with static + VHS tape.
  const screen = createStaticScreen();
  disposables.push(screen);
  const tv = new THREE.Group();
  const tvBody = new THREE.Mesh(track(boxGeo(0.62, 0.5, 0.48, 0, 0.25, 0)), mat.plastic);
  const screenMat = track(new THREE.MeshBasicMaterial({ map: screen.texture }));
  const tvScreen = new THREE.Mesh(track(new THREE.PlaneGeometry(0.46, 0.35)), screenMat);
  tvScreen.position.set(-0.03, 0.27, 0.242);
  const tvStand = new THREE.Mesh(track(boxGeo(0.7, 0.36, 0.5, 0, 0.18, 0)), mat.box);
  tvBody.position.y = 0.36;
  tvScreen.position.y += 0.36;
  tv.add(tvStand, tvBody, tvScreen);
  tvBody.castShadow = true;
  placeFrame(tv, ot.tv);
  const tvLight = new THREE.PointLight(0xaab8ff, 0, 5, 1.8);
  tvLight.position.set(ot.tv.x + ot.tv.normal.x * 0.6, 0.7, ot.tv.z + ot.tv.normal.z * 0.6);
  root.add(tvLight);
  let tvMode = "static";
  let tvRedraw = 0;

  const tape = new THREE.Mesh(track(boxGeo(0.19, 0.026, 0.105, 0, 0.013, 0)), mat.tape);
  tape.position.set(ot.tape.x, 0.0, ot.tape.z);
  tape.rotation.y = ot.tape.yaw;
  tape.castShadow = true;
  root.add(tape);

  // Exit door set into the outer wall, with a blinding chamber behind it.
  const door = new THREE.Group();
  const doorW = 1.3;
  const doorH = 2.2;
  // Side pieces stop at +-(CELL/2 - T/2): the neighbouring wall runs already cover the rest.
  const sideW = (CELL - T) / 2 - doorW / 2;
  const sideGeo = track(boxGeo(sideW, H, T));
  const leftPiece = new THREE.Mesh(sideGeo, mat.wall);
  leftPiece.position.set(-(doorW / 2 + sideW / 2), H / 2, 0);
  const rightPiece = new THREE.Mesh(sideGeo, mat.wall);
  rightPiece.position.set(doorW / 2 + sideW / 2, H / 2, 0);
  const lintel = new THREE.Mesh(track(boxGeo(doorW, H - doorH, T)), mat.wall);
  lintel.position.set(0, doorH + (H - doorH) / 2, 0);
  const frameGeo = track(boxGeo(0.08, doorH, T + 0.06));
  const frameL = new THREE.Mesh(frameGeo, mat.darkMetal);
  frameL.position.set(-doorW / 2 - 0.04, doorH / 2, 0);
  const frameR = new THREE.Mesh(frameGeo, mat.darkMetal);
  frameR.position.set(doorW / 2 + 0.04, doorH / 2, 0);
  const frameTop = new THREE.Mesh(track(boxGeo(doorW + 0.16, 0.08, T + 0.06)), mat.darkMetal);
  frameTop.position.set(0, doorH + 0.04, 0);
  const doorPanel = new THREE.Mesh(track(boxGeo(doorW, doorH, 0.07)), mat.metalDoor);
  doorPanel.position.set(0, doorH / 2, 0);
  const sign = new THREE.Mesh(track(new THREE.PlaneGeometry(0.62, 0.23)), mat.sign);
  sign.position.set(0, doorH + 0.32, T / 2 + 0.01);
  const redLampBox = new THREE.Mesh(track(boxGeo(0.22, 0.12, 0.12)), mat.redLamp);
  redLampBox.position.set(0, H - 0.1, T / 2 + 0.06);
  const chamber = new THREE.Mesh(track(boxGeo(doorW + 0.02, H - 0.01, 3.2, 0, H / 2, -1.7)), mat.chamber);
  door.add(leftPiece, rightPiece, lintel, frameL, frameR, frameTop, doorPanel, sign, redLampBox, chamber);
  [leftPiece, rightPiece, lintel, doorPanel].forEach((m) => (m.castShadow = true));
  placeFrame(door, ot.door);
  const exitRed = new THREE.PointLight(0xff2a14, 0, 14, 1.4);
  exitRed.position.set(ot.door.x + ot.door.normal.x * 0.6, H - 0.35, ot.door.z + ot.door.normal.z * 0.6);
  root.add(exitRed);
  const exitWhite = new THREE.PointLight(0xfff6e8, 0, 16, 1.2);
  exitWhite.position.set(ot.door.x - ot.door.normal.x * 0.4, 1.6, ot.door.z - ot.door.normal.z * 0.4);
  root.add(exitWhite);
  let doorProgress = 0;
  let exitPowered = false;
  let alarm = false;

  // Batteries.
  const batteryGeo = mergeGeometries([new THREE.CylinderGeometry(0.03, 0.03, 0.1, 10).translate(0, 0.05, 0), new THREE.CylinderGeometry(0.012, 0.012, 0.012, 8).translate(0, 0.106, 0)]);
  const batteries = instanced(batteryGeo, mat.battery, map.batteries.length, { shadow: false });
  const batteryInfo = map.batteries.map((index) => {
    const t = batteryTransform(map, index);
    const slot = pushInstance(batteries, t.x, 0, t.z, t.yaw);
    return { index, x: t.x, z: t.z, slot, taken: false };
  });

  // --- runtime -----------------------------------------------------------------
  const sequences = [];
  let time = 0;
  let gainTarget = 0.82;
  let gain = 0.82;
  let gainDip = 0;

  function update(dt, player) {
    time += dt;

    // Scripted lamp sequences (flicker waves, blackouts).
    for (let k = sequences.length - 1; k >= 0; k--) {
      const sq = sequences[k];
      while (sq.steps.length && sq.steps[0].at <= time) {
        const st = sq.steps.shift();
        lampOverride[st.lamp] = st.level;
        if (st.level === null) lampOverride[st.lamp] = -1;
        if (st.state !== undefined) lampState[st.lamp] = st.state;
        setLamp(st.lamp, lampState[st.lamp]);
      }
      if (!sq.steps.length) sequences.splice(k, 1);
    }

    // Pool assignment.
    poolTimer -= dt;
    if (poolTimer <= 0) {
      poolTimer = 0.2;
      const near = [];
      for (const i of flickering) {
        const d = (lampPos[i].x - player.x) ** 2 + (lampPos[i].z - player.z) ** 2;
        if (d < 22 * 22) near.push({ i, d });
      }
      near.sort((a, b) => a.d - b.d);
      pool.forEach((light, k) => {
        const pick = near[k];
        light.userData.lamp = pick ? pick.i : -1;
        if (pick) light.position.set(lampPos[pick.i].x, H - 0.25, lampPos[pick.i].z);
      });
    }

    // Flicker: pooled lights + fixture colours of flickering lamps.
    for (const i of flickering) writeLampColor(i, flickerValue(map.lamps[i].phase, time));
    let nearestTick = null;
    for (const light of pool) {
      const li = light.userData.lamp;
      if (li < 0) {
        light.intensity = 0;
        continue;
      }
      const f = flickerValue(map.lamps[li].phase, time);
      const prevF = light.userData.f ?? f;
      light.userData.f = f;
      const d = Math.hypot(lampPos[li].x - player.x, lampPos[li].z - player.z);
      const fade = Math.min(1, Math.max(0, (22 - d) / 6));
      light.intensity = f * 9 * fade * gain;
      if (prevF < 0.3 && f > 0.5 && (!nearestTick || d < nearestTick.d)) nearestTick = { x: lampPos[li].x, z: lampPos[li].z, d };
    }
    if (nearestTick && nearestTick.d < 14 && time - lastTickAt > 0.35) {
      lastTickAt = time;
      lampTicks.push(nearestTick);
    }

    // Global power level (stage + events).
    gainDip = Math.max(0, gainDip - dt * 0.5);
    const alarmPulse = alarm ? 0.75 + 0.25 * Math.sin(time * 5.5) : 1;
    gain += (gainTarget * alarmPulse * (1 - gainDip) - gain) * Math.min(1, dt * 4);
    lamp.uniforms.uLampGain.value = gain;
    lampMesh.material.color.setScalar(0.35 + gain * 0.65);

    if (lightField.isDirty()) lamp.upload();

    // TV static (only animated nearby).
    const tvD = Math.hypot(ot.tv.x - player.x, ot.tv.z - player.z);
    tvRedraw -= dt;
    if (tvD < 18 && tvRedraw <= 0) {
      tvRedraw = 1 / 15;
      screen.draw(tvMode);
    }
    tvLight.intensity = tvMode === "static" ? 0.9 + Math.random() * 0.5 : tvMode === "blue" ? 0.8 : 0;

    // Panel LEDs blink until powered.
    const blink = Math.floor(time * 2) % 2 === 0;
    leds.forEach((led, k) => (led.visible = panel.userData.powered ? true : k === 0 ? blink : false));

    // Exit: red emergency light once powered, alarm strobe during the escape.
    const strobe = alarm ? (Math.sin(time * 9) > 0 ? 1 : 0.15) : 1;
    exitRed.intensity = exitPowered ? 6 * strobe : 0;
    mat.redLamp.color.setRGB(exitPowered ? 2.5 * strobe : 0.13, exitPowered ? 0.12 : 0.02, exitPowered ? 0.08 : 0.02);
    mat.sign.color.setScalar(exitPowered ? 1.6 : 0.14);
    doorPanel.position.x = -doorProgress * (doorW + 0.05);
    exitWhite.intensity = doorProgress * 30;
  }

  function lampsNear(x, z, radius) {
    const out = [];
    for (let i = 0; i < lampPos.length; i++) {
      const d = Math.hypot(lampPos[i].x - x, lampPos[i].z - z);
      if (d < radius) out.push({ i, d });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  return {
    root,
    staticMeshes,
    lampPositions: lampPos,
    lampState,
    LAMP,
    objectives: ot,
    batteries: batteryInfo,
    update,
    isLampLit: (i) => lampState[i] === LAMP.ON && lampOverride[i] < 0,
    setLamp,
    lampsNear,
    drainLampTicks() {
      return lampTicks.splice(0);
    },
    // Short dim/kill on a list of lamps, staggered (flicker wave, sequential outage).
    lampSequence(list, { interval = 0.12, level = 0.05, hold = 0.25 } = {}) {
      const steps = [];
      list.forEach((li, k) => {
        if (lampState[li] !== LAMP.ON) return;
        steps.push({ at: time + k * interval, lamp: li, level });
        steps.push({ at: time + k * interval + hold, lamp: li, level: null });
      });
      steps.sort((a, b) => a.at - b.at);
      if (steps.length) sequences.push({ steps });
      return steps.length > 0;
    },
    setPoolSize(n) {
      while (pool.length < n) {
        const light = new THREE.PointLight(0xfff2d6, 0, 9, 1.6);
        light.userData.lamp = -1;
        root.add(light);
        pool.push(light);
      }
      while (pool.length > n) {
        const light = pool.pop();
        root.remove(light);
        light.dispose();
      }
      poolTimer = 0;
    },
    setPowerGain(v) {
      gainTarget = v;
    },
    dipPower(amount) {
      gainDip = Math.min(1, gainDip + amount);
    },
    setAlarm(on) {
      alarm = on;
    },
    setPanelPowered() {
      panel.userData.powered = true;
      leds.forEach((l) => (l.material = mat.ledGreen));
      lever.rotation.x = 0.6;
    },
    takeTape() {
      tape.visible = false;
      tvMode = "blue";
    },
    setTv(mode) {
      tvMode = mode;
    },
    setExitPowered(on) {
      exitPowered = on;
    },
    setDoorProgress(p) {
      doorProgress = Math.max(0, Math.min(1, p));
      if (doorProgress >= 1 && exitBoxes?.door !== undefined) collision.setEnabled(exitBoxes.door, false);
    },
    takeBattery(k) {
      const b = batteryInfo[k];
      if (!b || b.taken) return;
      b.taken = true;
      tmpObj.position.set(0, -50, 0);
      tmpObj.scale.setScalar(0.0001);
      tmpObj.updateMatrix();
      batteries.setMatrixAt(b.slot, tmpObj.matrix);
      batteries.instanceMatrix.needsUpdate = true;
    },
    // Event: a chair is quietly somewhere else when you look back.
    moveChair(prop, rng) {
      const slot = chairIndex.get(prop);
      const entry = collision.propBoxes.find((pb) => pb.prop === prop);
      if (slot === undefined || !entry) return false;
      // Somewhere else along a wall of the same cell (never in the walking line).
      const walls = [0, 1, 2, 3].filter((dir) => hasWall(g, prop.x, prop.y, dir));
      if (!walls.length) return false;
      const f = wallFrame(g, prop.x, prop.y, rng.pick(walls), 0.45);
      const slide = rng.range(-0.6, 0.6);
      const nx = f.x + f.tangent.x * slide;
      const nz = f.z + f.tangent.z * slide;
      const yaw = rng.range(-Math.PI, Math.PI);
      const hw = PROP_SIZE.chair.hw * 1.42;
      collision.moveBox(entry.box, nx - hw, nz - hw, nx + hw, nz + hw);
      tmpObj.position.set(nx, 0, nz);
      tmpObj.rotation.set(0, yaw, rng.chance(0.3) ? Math.PI / 2 : 0);
      if (tmpObj.rotation.z) tmpObj.position.y = 0.25;
      tmpObj.scale.setScalar(1);
      tmpObj.updateMatrix();
      chairs.setMatrixAt(slot, tmpObj.matrix);
      chairs.instanceMatrix.needsUpdate = true;
      chairs.computeBoundingSphere();
      return true;
    },
    chairProps: () => byType("chair"),
    addDoor(slot) {
      if (fakeDoors.count >= fakeDoors.instanceMatrix.count) return false;
      const f = wallFrame(g, slot.x, slot.y, slot.dir, -0.005);
      pushInstance(fakeDoors, f.x, 0, f.z, f.yaw);
      // Instanced bounds are cached on first render; refresh so the new door is not culled.
      fakeDoors.computeBoundingSphere();
      return true;
    },
    // Wall slots already taken by props or objectives (a new door must not cover them).
    usedWallSlots: () => {
      const { power, tape, exit } = map.objectives;
      const slots = map.props.filter((p) => ["wallStain", "vent", "fakeDoor", "scribble", "desk", "boxes", "chair"].includes(p.type)).map((p) => `${p.index}:${p.dir}`);
      return new Set([...slots, `${power.index}:${power.dir}`, `${tape.index}:${tape.dir}`, `${exit.index}:${exit.dir}`]);
    },
    dispose() {
      scene.remove(root);
      root.traverse((o) => {
        if (o.isInstancedMesh) o.dispose();
      });
      disposables.forEach((d) => d.dispose?.());
    },
  };
}
