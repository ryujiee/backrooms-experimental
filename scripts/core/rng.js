// Deterministic PRNG (mulberry32). All gameplay randomness goes through an Rng
// instance so the same seed reproduces the same map, placements and event rolls.

export function hashSeed(input) {
  const str = String(input);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function randomSeedLabel() {
  return String(Math.floor(100000 + Math.random() * 899999));
}

export function createRng(seed) {
  let a = typeof seed === "number" ? seed >>> 0 : hashSeed(seed);

  function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const rng = {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
    // items: [{ weight, ... }]; returns null when every weight is 0.
    weighted(items) {
      let total = 0;
      for (const it of items) total += Math.max(0, it.weight);
      if (total <= 0) return null;
      let roll = next() * total;
      for (const it of items) {
        roll -= Math.max(0, it.weight);
        if (roll < 0) return it;
      }
      return items[items.length - 1];
    },
  };
  return rng;
}

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Frame-rate independent exponential approach.
export function damp(current, target, rate, dt) {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}
