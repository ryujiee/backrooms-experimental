import * as THREE from "three";
import { generateLayout } from "./procgen.js";
import { clamp, randRange } from "./utils.js";

const cellSize = 8;
const wallHeight = 3;
const wallThickness = 0.4;
const playerRadius = 0.45;

export function createWorld(scene) {
  const layout = generateLayout(28, 28, 520);

  const group = new THREE.Group();
  scene.add(group);

  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0xb8ad5a,
    roughness: 0.9,
    metalness: 0,
  });

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0x9a8f4a,
    roughness: 0.95,
  });

  const ceilingMaterial = new THREE.MeshStandardMaterial({
    color: 0x776e3a,
    roughness: 1,
    metalness: 0,
  });

  const floorGeo = new THREE.PlaneGeometry(cellSize, cellSize);
  const wallGeo = new THREE.BoxGeometry(cellSize, wallHeight, wallThickness);
  const wallGeoSide = new THREE.BoxGeometry(wallThickness, wallHeight, cellSize);

  const floorMeshes = [];

  layout.visited.forEach((cell) => {
    const { x, y } = cell;
    const pos = cellToWorld(x, y, layout.width, layout.height);

    const floor = new THREE.Mesh(floorGeo, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(pos.x, 0, pos.z);
    floor.receiveShadow = false;
    group.add(floor);
    floorMeshes.push(floor);

    const ceil = new THREE.Mesh(floorGeo, ceilingMaterial);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(pos.x, wallHeight, pos.z);
    group.add(ceil);

    addWallsForCell(group, layout, x, y, pos);
  });

  const exitCell = layout.farthestCell;
  const exitPos = cellToWorld(exitCell.x, exitCell.y, layout.width, layout.height);
  const doorFrame = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 2.8, 0.35),
    new THREE.MeshStandardMaterial({ color: 0x3b0000, emissive: 0x5a0000 })
  );
  doorFrame.position.set(exitPos.x, 1.4, exitPos.z);
  doorFrame.castShadow = true;
  group.add(doorFrame);

  const innerCanvas = document.createElement("canvas");
  innerCanvas.width = 256;
  innerCanvas.height = 256;
  const ctx = innerCanvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0, "#b9e7ff");
  gradient.addColorStop(1, "#4f84ff");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 25; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const r = 20 + Math.random() * 30;
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.4, r, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const skyTexture = new THREE.CanvasTexture(innerCanvas);
  const portal = new THREE.Mesh(
    new THREE.PlaneGeometry(2.1, 2.3),
    new THREE.MeshBasicMaterial({ map: skyTexture, toneMapped: false })
  );
  portal.position.set(exitPos.x, 1.35, exitPos.z - 0.12);
  group.add(portal);

  const exitLight = new THREE.PointLight(0x9bd6ff, 4.2, 22);
  exitLight.position.set(exitPos.x, 2.1, exitPos.z - 0.4);
  group.add(exitLight);

  const lights = [];
  const lampMeshes = [];
  layout.visited.forEach((cell, index) => {
    if (index % 3 !== 0) return;
    const pos = cellToWorld(cell.x, cell.y, layout.width, layout.height);
    const isDark = Math.random() < 0.28;
    const light = new THREE.PointLight(0xffffff, isDark ? 0.12 : 2.3, isDark ? 6 : 22, 2);
    light.position.set(pos.x, wallHeight - 0.15, pos.z);
    light.castShadow = false;
    light.userData.base = isDark ? randRange(0.08, 0.22) : randRange(1.3, 2.6);
    light.userData.phase = randRange(0, Math.PI * 2);
    light.userData.off = isDark ? Math.random() < 0.7 : Math.random() < 0.12;
    lights.push(light);
    group.add(light);

    const lamp = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 0.12, 0.4),
      new THREE.MeshStandardMaterial({
        color: 0xe6e6e6,
        emissive: 0x444444,
        roughness: 0.4,
      })
    );
    lamp.position.set(pos.x, wallHeight - 0.05, pos.z);
    lampMeshes.push(lamp);
    group.add(lamp);
  });

  const startPosition = cellToWorld(layout.startCell.x, layout.startCell.y, layout.width, layout.height);

  function updateLights(time) {
    lights.forEach((light, index) => {
      if (light.userData.off) {
        light.intensity = 0.02;
        lampMeshes[index].material.emissive.setHex(0x101010);
        return;
      }
      const flicker = 0.7 + 0.3 * Math.sin(time * 2 + light.userData.phase);
      const intensity = light.userData.base * flicker;
      light.intensity = intensity;
      lampMeshes[index].material.emissive.setScalar(0.3 + intensity * 0.5);
    });
  }

  function isAtExit(position) {
    const dx = position.x - exitPos.x;
    const dz = position.z - exitPos.z;
    return Math.hypot(dx, dz) < 2.2;
  }

  function tryMove(current, delta, yaw) {
    const forward = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const right = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);

    const moveWorld = new THREE.Vector3();
    moveWorld.addScaledVector(right, delta.x);
    moveWorld.addScaledVector(forward, delta.z);

    let next = current.clone();

    next = attemptAxisMove(current, moveWorld.x, 0, next, layout);
    next = attemptAxisMove(next, 0, moveWorld.z, next, layout);

    const cell = worldToCell(next, layout.width, layout.height);
    return constrainToCell(next, cell, layout);
  }

  return {
    layout,
    startPosition,
    cellSize,
    updateLights,
    tryMove,
    isAtExit,
  };
}

function attemptAxisMove(origin, dx, dz, base, layout) {
  if (dx === 0 && dz === 0) return base;
  const candidate = base.clone().add(new THREE.Vector3(dx, 0, dz));
  const from = worldToCell(origin, layout.width, layout.height);
  const to = worldToCell(candidate, layout.width, layout.height);

  if (from.x === to.x && from.y === to.y) return candidate;
  if (layout.isOpenBetween(from.x, from.y, to.x, to.y)) return candidate;
  return base;
}

function addWallsForCell(group, layout, x, y, pos) {
  const dirs = [
    { dx: 0, dy: -1, dir: 0 },
    { dx: 1, dy: 0, dir: 1 },
    { dx: 0, dy: 1, dir: 2 },
    { dx: -1, dy: 0, dir: 3 },
  ];

  dirs.forEach((d) => {
    const nx = x + d.dx;
    const ny = y + d.dy;
    const hasNeighbor = layout.isVisited(nx, ny);

    const shouldPlace = !layout.isOpenEdge(x, y, d.dir) && (!hasNeighbor || d.dir === 0 || d.dir === 3);

    if (!shouldPlace) return;

    if (d.dir === 0 || d.dir === 2) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(cellSize, wallHeight, wallThickness),
        new THREE.MeshStandardMaterial({ color: 0x9a8f4a, roughness: 0.95 }));
      wall.position.set(pos.x, wallHeight / 2, pos.z + (d.dir === 0 ? -cellSize / 2 : cellSize / 2));
      wall.castShadow = false;
      wall.receiveShadow = false;
      group.add(wall);
    } else {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(wallThickness, wallHeight, cellSize),
        new THREE.MeshStandardMaterial({ color: 0x9a8f4a, roughness: 0.95 }));
      wall.position.set(pos.x + (d.dir === 3 ? -cellSize / 2 : cellSize / 2), wallHeight / 2, pos.z);
      wall.castShadow = false;
      wall.receiveShadow = false;
      group.add(wall);
    }
  });
}

function cellToWorld(x, y, width, height) {
  const originX = (x - width / 2) * cellSize + cellSize / 2;
  const originZ = (y - height / 2) * cellSize + cellSize / 2;
  return { x: originX, z: originZ };
}

function worldToCell(position, width, height) {
  const x = Math.floor(position.x / cellSize + width / 2);
  const y = Math.floor(position.z / cellSize + height / 2);
  return { x: clamp(x, 0, width - 1), y: clamp(y, 0, height - 1) };
}

function constrainToCell(position, cell, layout) {
  const center = cellToWorld(cell.x, cell.y, layout.width, layout.height);
  const half = cellSize / 2;

  let minX = center.x - half + playerRadius;
  let maxX = center.x + half - playerRadius;
  let minZ = center.z - half + playerRadius;
  let maxZ = center.z + half - playerRadius;

  if (layout.isOpenEdge(cell.x, cell.y, 0)) minZ = -Infinity;
  if (layout.isOpenEdge(cell.x, cell.y, 2)) maxZ = Infinity;
  if (layout.isOpenEdge(cell.x, cell.y, 3)) minX = -Infinity;
  if (layout.isOpenEdge(cell.x, cell.y, 1)) maxX = Infinity;

  position.x = clamp(position.x, minX, maxX);
  position.z = clamp(position.z, minZ, maxZ);
  return position;
}
