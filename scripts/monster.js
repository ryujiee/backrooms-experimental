import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { pick } from "./utils.js";

export function createMonster(scene, world) {
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.4, 1.4, 4, 8),
    new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 })
  );
  const monsterGroup = new THREE.Group();
  const spawnCell = pickFarthestCell(world.layout.visited, world.startPosition, world);
  const spawnPos = cellToWorld(spawnCell, world);
  monsterGroup.position.set(spawnPos.x, 1.1, spawnPos.z);
  body.castShadow = true;
  monsterGroup.add(body);
  scene.add(monsterGroup);

  const gltfLoader = new GLTFLoader();
  gltfLoader.load(
    "assets/models/bacteria_lifeform_backrooms.glb",
    (gltf) => {
      const model = gltf.scene;
      model.scale.set(0.7, 0.7, 0.7);
      model.rotation.set(0, Math.PI, 0);
      model.position.set(0, -0.9, 0);
      model.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      monsterGroup.add(model);
      body.visible = false;
    },
    undefined,
    () => {}
  );

  let target = pick(world.layout.visited);
  let path = [];
  let state = "patrol";
  let lastDir = new THREE.Vector3(0, 0, -1);
  let screamActive = false;
  let pathTimer = 0;
  let chaseTimer = 0;
  let lastSeenCell = null;

  function update(delta, playerPos, flashlightOn, audio) {
    const playerCell = worldToCell(playerPos, world);
    const monsterCell = worldToCell(monsterGroup.position, world);
    const dist = monsterGroup.position.distanceTo(playerPos);

    const canSee =
      hasLineOfSight(monsterCell, playerCell, world.layout) &&
      isInFront(playerPos, monsterGroup.position, lastDir, Math.cos(Math.PI / 3));

    if (dist < 20 || (flashlightOn && dist < 26) || canSee) {
      state = "chase";
      chaseTimer = 2.5;
      lastSeenCell = playerCell;
    } else if (dist > 26) {
      chaseTimer -= delta;
      if (chaseTimer <= 0) {
        state = "patrol";
      } else {
        state = "chase";
      }
    }

    pathTimer += delta;
    if (state === "chase") {
      if (!screamActive && audio) {
        audio.playMonsterLoop();
        screamActive = true;
      }
      if (pathTimer > 0.25) {
        const targetCell = lastSeenCell || playerCell;
        path = findPath(monsterCell, targetCell, world.layout);
        pathTimer = 0;
      }
    } else {
      if (screamActive && audio) {
        audio.stopMonsterLoop();
        screamActive = false;
      }
      if (!target || monsterGroup.position.distanceTo(cellToWorld(target, world)) < 1.5 || pathTimer > 1.2) {
        target = pick(world.layout.visited);
        path = findPath(monsterCell, target, world.layout);
        pathTimer = 0;
      }
    }

    const speed = state === "chase" ? 3.9 : 1.1;
    const goal = nextGoalFromPath(path, world);
    if (goal) {
      const dir = goal.clone().sub(monsterGroup.position);
      if (dir.length() > 0.01) {
        dir.normalize();
        monsterGroup.position.addScaledVector(dir, speed * delta);
        lastDir.copy(dir);
        monsterGroup.rotation.y = Math.atan2(dir.x, dir.z);
      }
    }
  }

  function isPlayerCaught(playerPos) {
    return monsterGroup.position.distanceTo(playerPos) < 1.6;
  }

  function getThreatLevel(playerPos) {
    const dist = monsterGroup.position.distanceTo(playerPos);
    return Math.max(0, 1 - dist / 18);
  }

  return {
    update,
    isPlayerCaught,
    getThreatLevel,
    getPosition: () => monsterGroup.position,
  };
}

function cellToWorld(cell, world) {
  const pos = world.layout;
  const x = (cell.x - pos.width / 2) * world.cellSize + world.cellSize / 2;
  const z = (cell.y - pos.height / 2) * world.cellSize + world.cellSize / 2;
  return new THREE.Vector3(x, 1.1, z);
}

function worldToCell(position, world) {
  const x = Math.floor(position.x / world.cellSize + world.layout.width / 2);
  const y = Math.floor(position.z / world.cellSize + world.layout.height / 2);
  return {
    x: Math.max(0, Math.min(world.layout.width - 1, x)),
    y: Math.max(0, Math.min(world.layout.height - 1, y)),
  };
}

function isInFront(targetPos, origin, forward, cosLimit) {
  const dir = targetPos.clone().sub(origin).normalize();
  return dir.dot(forward) >= cosLimit;
}

function hasLineOfSight(from, to, layout) {
  if (from.x === to.x) {
    const step = from.y < to.y ? 1 : -1;
    for (let y = from.y; y !== to.y; y += step) {
      const nextY = y + step;
      if (!layout.isOpenBetween(from.x, y, from.x, nextY)) return false;
    }
    return true;
  }
  if (from.y === to.y) {
    const step = from.x < to.x ? 1 : -1;
    for (let x = from.x; x !== to.x; x += step) {
      const nextX = x + step;
      if (!layout.isOpenBetween(x, from.y, nextX, from.y)) return false;
    }
    return true;
  }
  return false;
}

function findPath(start, goal, layout) {
  const key = (c) => `${c.x},${c.y}`;
  const queue = [start];
  const cameFrom = new Map();
  cameFrom.set(key(start), null);

  while (queue.length) {
    const current = queue.shift();
    if (current.x === goal.x && current.y === goal.y) break;
    const neighbors = neighborsFrom(current, layout);
    for (const n of neighbors) {
      const k = key(n);
      if (cameFrom.has(k)) continue;
      cameFrom.set(k, current);
      queue.push(n);
    }
  }

  const path = [];
  let cur = goal;
  while (cur) {
    path.push(cur);
    cur = cameFrom.get(key(cur));
  }
  return path.reverse();
}

function neighborsFrom(cell, layout) {
  const list = [];
  const dirs = [
    { dx: 0, dy: -1 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 },
  ];
  for (const d of dirs) {
    const nx = cell.x + d.dx;
    const ny = cell.y + d.dy;
    if (nx < 0 || ny < 0 || nx >= layout.width || ny >= layout.height) continue;
    if (layout.isOpenBetween(cell.x, cell.y, nx, ny)) {
      list.push({ x: nx, y: ny });
    }
  }
  return list;
}

function nextGoalFromPath(path, world) {
  if (!path || path.length < 2) return null;
  const nextCell = path[1];
  return cellToWorld(nextCell, world);
}

function pickFarthestCell(cells, startPos, world) {
  let best = cells[0];
  let bestDist = -Infinity;
  for (const cell of cells) {
    const worldPos = cellToWorld(cell, world);
    const dx = worldPos.x - startPos.x;
    const dz = worldPos.z - startPos.z;
    const dist = dx * dx + dz * dz;
    if (dist > bestDist) {
      bestDist = dist;
      best = cell;
    }
  }
  return best;
}
