import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSettings, loadSettings, saveSettings, DEFAULT_SETTINGS, loadStats, saveStats } from "../scripts/core/settings.js";

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
}

test("sanitize clamps, rejects junk and keeps defaults", () => {
  const s = sanitizeSettings({ master: 500, sfx: -3, quality: "ultra", reduceMotion: "yes", seed: "  abc  ", fov: 80.4 });
  assert.equal(s.master, 100);
  assert.equal(s.sfx, 0);
  assert.equal(s.quality, DEFAULT_SETTINGS.quality);
  assert.equal(s.reduceMotion, false);
  assert.equal(s.seed, "abc");
  assert.equal(s.fov, 80);
  assert.deepEqual(sanitizeSettings(null), DEFAULT_SETTINGS);
});

test("settings and stats round-trip through storage; corrupt JSON falls back", () => {
  const st = fakeStorage();
  saveSettings({ ...DEFAULT_SETTINGS, master: 33, quality: "low" }, st);
  assert.equal(loadSettings(st).master, 33);
  assert.equal(loadSettings(st).quality, "low");
  st.setItem("backrooms-noclip:settings:v1", "{not json");
  assert.deepEqual(loadSettings(st), DEFAULT_SETTINGS);
  saveStats({ bestTime: 812.5, completed: true, runs: 3, deaths: 2 }, st);
  assert.deepEqual(loadStats(st), { bestTime: 812.5, completed: true, runs: 3, deaths: 2 });
});
