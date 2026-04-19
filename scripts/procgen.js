import { randInt, pick } from "./utils.js";

const DIRS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
];

export function generateLayout(width, height, steps) {
  const visited = new Set();
  const edges = new Set();

  const startCell = { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  let current = { ...startCell };

  function key(x, y) {
    return `${x},${y}`;
  }

  function edgeKey(x, y, dir) {
    return `${x},${y},${dir}`;
  }

  function openEdge(x, y, dir) {
    edges.add(edgeKey(x, y, dir));
    const opposite = (dir + 2) % 4;
    const nx = x + DIRS[dir].dx;
    const ny = y + DIRS[dir].dy;
    edges.add(edgeKey(nx, ny, opposite));
  }

  visited.add(key(current.x, current.y));

  for (let i = 0; i < steps; i++) {
    const dir = randInt(0, 3);
    const nx = current.x + DIRS[dir].dx;
    const ny = current.y + DIRS[dir].dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    openEdge(current.x, current.y, dir);
    current = { x: nx, y: ny };
    visited.add(key(current.x, current.y));
  }

  const visitedList = Array.from(visited).map((item) => {
    const [x, y] = item.split(",").map(Number);
    return { x, y };
  });

  const farthestCell = pick(visitedList.filter((cell) => cell.x + cell.y > width / 2 + height / 2));

  return {
    width,
    height,
    visited: visitedList,
    startCell,
    farthestCell,
    isVisited: (x, y) => visited.has(key(x, y)),
    isOpenEdge: (x, y, dir) => edges.has(edgeKey(x, y, dir)),
    isOpenBetween: (x1, y1, x2, y2) => {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const dirIndex = DIRS.findIndex((d) => d.dx === dx && d.dy === dy);
      if (dirIndex === -1) return false;
      return edges.has(edgeKey(x1, y1, dirIndex));
    },
  };
}
