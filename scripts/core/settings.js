// Persisted settings and stats (localStorage, with an in-memory fallback when
// storage is blocked, e.g. private mode or file:// sandboxes).

export const SETTINGS_KEY = "backrooms-noclip:settings:v1";
export const STATS_KEY = "backrooms-noclip:stats:v1";

export const QUALITY_LEVELS = ["auto", "low", "medium", "high"];

export const DEFAULT_SETTINGS = {
  master: 80,
  sfx: 85,
  ambience: 75,
  sensitivity: 100,
  fov: 72,
  quality: "auto",
  reduceMotion: false,
  subtitles: true,
  seed: "",
};

const RANGES = {
  master: [0, 100],
  sfx: [0, 100],
  ambience: [0, 100],
  sensitivity: [10, 300],
  fov: [60, 95],
};

export function sanitizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return out;
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const v = Number(raw[key]);
    if (Number.isFinite(v)) out[key] = Math.min(max, Math.max(min, Math.round(v)));
  }
  if (QUALITY_LEVELS.includes(raw.quality)) out.quality = raw.quality;
  if (typeof raw.reduceMotion === "boolean") out.reduceMotion = raw.reduceMotion;
  if (typeof raw.subtitles === "boolean") out.subtitles = raw.subtitles;
  if (typeof raw.seed === "string") out.seed = raw.seed.trim().slice(0, 24);
  return out;
}

export function sanitizeStats(raw) {
  const out = { bestTime: null, completed: false, runs: 0, deaths: 0 };
  if (!raw || typeof raw !== "object") return out;
  if (Number.isFinite(raw.bestTime) && raw.bestTime > 0) out.bestTime = raw.bestTime;
  out.completed = raw.completed === true;
  if (Number.isInteger(raw.runs) && raw.runs >= 0) out.runs = raw.runs;
  if (Number.isInteger(raw.deaths) && raw.deaths >= 0) out.deaths = raw.deaths;
  return out;
}

const memory = new Map();
const memoryStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
};

export function getStorage() {
  try {
    const s = globalThis.localStorage;
    s.getItem("__probe__");
    return s;
  } catch {
    return memoryStorage;
  }
}

function read(storage, key) {
  try {
    return JSON.parse(storage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function write(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or privacy errors must never break the game.
  }
}

export function loadSettings(storage = getStorage()) {
  return sanitizeSettings(read(storage, SETTINGS_KEY));
}

export function saveSettings(settings, storage = getStorage()) {
  write(storage, SETTINGS_KEY, sanitizeSettings(settings));
}

export function loadStats(storage = getStorage()) {
  return sanitizeStats(read(storage, STATS_KEY));
}

export function saveStats(stats, storage = getStorage()) {
  write(storage, STATS_KEY, sanitizeStats(stats));
}

// Mouse slider (10..300, default 100) -> radians per pixel.
export function sensitivityToRadians(value) {
  return (value / 100) * 0.0022;
}
