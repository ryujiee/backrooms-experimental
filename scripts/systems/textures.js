import * as THREE from "three";
import { createRng } from "../core/rng.js";

// Procedural canvas textures. Generated locally at boot: no external image assets,
// no licensing questions, ~0 bytes of download. Everything that tiles wraps cleanly.

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext("2d", { willReadFrequently: true }) };
}

function noisePixels(ctx, w, h, amount, rng, mono = true) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng.next() - 0.5) * amount;
    d[i] += n;
    d[i + 1] += mono ? n : n * 0.9;
    d[i + 2] += mono ? n : n * 0.7;
  }
  ctx.putImageData(img, 0, 0);
}

// Draw a shape at x and its horizontally/vertically wrapped copies (seamless tiling).
function wrapDraw(w, h, x, y, r, draw) {
  for (const ox of [-w, 0, w]) {
    for (const oy of [-h, 0, h]) {
      if (x + ox + r < 0 || x + ox - r > w || y + oy + r < 0 || y + oy - r > h) continue;
      draw(x + ox, y + oy);
    }
  }
}

function blotch(ctx, x, y, r, color, alpha) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${color},${alpha})`);
  g.addColorStop(0.6, `rgba(${color},${alpha * 0.45})`);
  g.addColorStop(1, `rgba(${color},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function toTexture(c, { repeat = true, srgb = true, aniso = 4 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// 1.5 m wide x full wall height. Mono-yellow wallpaper, faint stripes and motif, baseboard.
function wallpaper(rng) {
  const W = 512;
  const H = 1024;
  const { c, ctx } = canvas(W, H);
  const base = ctx.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0, "#b9a55e");
  base.addColorStop(0.5, "#c8b36a");
  base.addColorStop(1, "#b7a35c");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);

  // Vertical stripe pairs.
  for (let x = 0; x < W; x += 64) {
    ctx.fillStyle = "rgba(255,240,180,0.07)";
    ctx.fillRect(x + 4, 0, 6, H);
    ctx.fillStyle = "rgba(90,70,20,0.06)";
    ctx.fillRect(x + 12, 0, 2, H);
  }
  // Small chevron motif between stripes.
  ctx.strokeStyle = "rgba(110,90,35,0.08)";
  ctx.lineWidth = 2;
  for (let y = 20; y < H; y += 40) {
    for (let x = 32; x < W; x += 64) {
      const yy = y + ((x / 64) % 2) * 20;
      ctx.beginPath();
      ctx.moveTo(x - 7, yy + 5);
      ctx.lineTo(x, yy - 3);
      ctx.lineTo(x + 7, yy + 5);
      ctx.stroke();
    }
  }
  // Age: soft blotches, water streaks from the ceiling, grime near the floor.
  for (let i = 0; i < 22; i++) {
    const x = rng.range(0, W);
    const y = rng.range(0, H);
    const r = rng.range(30, 120);
    wrapDraw(W, H, x, y, r, (px, py) => blotch(ctx, px, py, r, "95,75,25", rng.range(0.04, 0.1)));
  }
  for (let i = 0; i < 7; i++) {
    const x = rng.range(0, W);
    const len = rng.range(120, 420);
    const g = ctx.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, "rgba(90,70,30,0.16)");
    g.addColorStop(1, "rgba(90,70,30,0)");
    ctx.fillStyle = g;
    wrapDraw(W, H, x, 0, 12, (px) => ctx.fillRect(px - rng.range(2, 6), 0, rng.range(3, 10), len));
  }
  const grime = ctx.createLinearGradient(0, H * 0.82, 0, H);
  grime.addColorStop(0, "rgba(70,55,20,0)");
  grime.addColorStop(1, "rgba(70,55,20,0.22)");
  ctx.fillStyle = grime;
  ctx.fillRect(0, H * 0.82, W, H * 0.18);
  const top = ctx.createLinearGradient(0, 0, 0, 50);
  top.addColorStop(0, "rgba(60,50,20,0.25)");
  top.addColorStop(1, "rgba(60,50,20,0)");
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, W, 50);
  // Baseboard (~10 cm).
  const bb = Math.round(H * 0.035);
  ctx.fillStyle = "#6c5b2f";
  ctx.fillRect(0, H - bb, W, bb);
  ctx.fillStyle = "rgba(255,230,160,0.18)";
  ctx.fillRect(0, H - bb, W, 2);
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(0, H - bb - 2, W, 2);
  noisePixels(ctx, W, H, 14, rng);
  return c;
}

// Mustard carpet, 2 m tile.
function carpet(rng) {
  const S = 512;
  const { c, ctx } = canvas(S, S);
  ctx.fillStyle = "#8e7c43";
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 40; i++) {
    const x = rng.range(0, S);
    const y = rng.range(0, S);
    const r = rng.range(20, 90);
    const dark = rng.chance(0.6);
    wrapDraw(S, S, x, y, r, (px, py) => blotch(ctx, px, py, r, dark ? "60,48,20" : "180,160,95", rng.range(0.05, 0.12)));
  }
  // Fibres.
  for (let i = 0; i < 26000; i++) {
    const x = rng.range(0, S);
    const y = rng.range(0, S);
    const v = rng.range(-1, 1);
    ctx.fillStyle = v > 0 ? `rgba(200,180,110,${v * 0.22})` : `rgba(40,30,10,${-v * 0.28})`;
    ctx.fillRect(x, y, rng.chance(0.5) ? 2 : 1, rng.chance(0.5) ? 2 : 1);
  }
  noisePixels(ctx, S, S, 18, rng);
  return c;
}

// Acoustic ceiling tiles: 4x4 tiles of 0.6 m (2.4 m texture).
function ceiling(rng) {
  const S = 512;
  const T = S / 4;
  const { c, ctx } = canvas(S, S);
  for (let ty = 0; ty < 4; ty++) {
    for (let tx = 0; tx < 4; tx++) {
      const v = rng.range(-8, 8);
      ctx.fillStyle = `rgb(${212 + v},${202 + v},${166 + v})`;
      ctx.fillRect(tx * T, ty * T, T, T);
      for (let i = 0; i < 260; i++) {
        ctx.fillStyle = `rgba(80,70,40,${rng.range(0.1, 0.35)})`;
        ctx.fillRect(tx * T + rng.range(4, T - 4), ty * T + rng.range(4, T - 4), 1.5, 1.5);
      }
      if (rng.chance(0.18)) {
        const cx = tx * T + rng.range(30, T - 30);
        const cy = ty * T + rng.range(30, T - 30);
        const r = rng.range(15, 45);
        blotch(ctx, cx, cy, r, "120,90,40", 0.35);
        ctx.strokeStyle = "rgba(110,80,30,0.3)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
  ctx.fillStyle = "#857a55";
  for (let i = 0; i <= 4; i++) {
    ctx.fillRect(i * T - 2, 0, 4, S);
    ctx.fillRect(0, i * T - 2, S, 4);
  }
  noisePixels(ctx, S, S, 10, rng);
  return c;
}

function lampPanel() {
  const { c, ctx } = canvas(128, 64);
  ctx.fillStyle = "#e9eef0";
  ctx.fillRect(0, 0, 128, 64);
  ctx.fillStyle = "rgba(160,170,175,0.6)";
  for (let x = 8; x < 128; x += 8) ctx.fillRect(x, 4, 1, 56);
  for (let y = 8; y < 64; y += 8) ctx.fillRect(4, y, 120, 1);
  ctx.strokeStyle = "#8d8f88";
  ctx.lineWidth = 6;
  ctx.strokeRect(0, 0, 128, 64);
  return c;
}

// Tileable value noise (macro albedo variation that breaks texture repetition).
function macroNoise(rng) {
  const S = 256;
  const { c, ctx } = canvas(S, S);
  const grid = 8;
  const vals = Array.from({ length: grid * grid }, () => rng.next());
  const at = (x, y) => vals[((y + grid) % grid) * grid + ((x + grid) % grid)];
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let v = 0;
      let amp = 0.6;
      let freq = 1;
      for (let o = 0; o < 3; o++) {
        const gx = ((x / S) * grid * freq) % grid;
        const gy = ((y / S) * grid * freq) % grid;
        const ix = Math.floor(gx);
        const iy = Math.floor(gy);
        const fx = gx - ix;
        const fy = gy - iy;
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);
        const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
        const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
        v += (a + (b - a) * sy) * amp;
        amp *= 0.5;
        freq *= 2;
      }
      const o = (y * S + x) * 4;
      const g = Math.max(0, Math.min(255, (v / 1.05) * 255));
      img.data[o] = img.data[o + 1] = img.data[o + 2] = g;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// 4x4 atlas: row 0 wall stains, row 1 floor stains, row 2 scribbles, row 3 ceiling hole / vent / misc.
function decalAtlas(rng) {
  const S = 1024;
  const T = 256;
  const { c, ctx } = canvas(S, S);
  ctx.clearRect(0, 0, S, S);
  const cell = (col, row, fn) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(col * T, row * T, T, T);
    ctx.clip();
    ctx.translate(col * T, row * T);
    fn(ctx);
    ctx.restore();
  };
  for (let i = 0; i < 4; i++) {
    cell(i, 0, (k) => {
      for (let b = 0; b < 14; b++) blotch(k, rng.range(70, 186), rng.range(60, 196), rng.range(18, 60), i % 2 ? "60,45,15" : "35,30,15", rng.range(0.12, 0.3));
      if (i >= 2) {
        for (let d = 0; d < 6; d++) {
          const x = rng.range(80, 176);
          const g = k.createLinearGradient(0, 100, 0, 250);
          g.addColorStop(0, "rgba(50,38,12,0.35)");
          g.addColorStop(1, "rgba(50,38,12,0)");
          k.fillStyle = g;
          k.fillRect(x, 110, rng.range(2, 6), rng.range(60, 140));
        }
      }
    });
    cell(i, 1, (k) => {
      for (let b = 0; b < 10; b++) blotch(k, rng.range(60, 196), rng.range(60, 196), rng.range(25, 75), i < 2 ? "40,32,12" : "55,40,15", rng.range(0.15, 0.32));
    });
  }
  // Scribbles: tally marks, an arrow, a smeared handprint, a scrawled word.
  cell(0, 2, (k) => {
    k.strokeStyle = "rgba(30,20,10,0.75)";
    k.lineWidth = 5;
    k.lineCap = "round";
    for (let g = 0; g < 3; g++) {
      for (let s = 0; s < 4; s++) {
        k.beginPath();
        k.moveTo(40 + g * 70 + s * 12, 90 + rng.range(-4, 4));
        k.lineTo(42 + g * 70 + s * 12, 160 + rng.range(-4, 4));
        k.stroke();
      }
      k.beginPath();
      k.moveTo(34 + g * 70, 150);
      k.lineTo(90 + g * 70, 100);
      k.stroke();
    }
  });
  cell(1, 2, (k) => {
    k.strokeStyle = "rgba(120,20,15,0.7)";
    k.lineWidth = 9;
    k.lineCap = "round";
    k.beginPath();
    k.moveTo(40, 128);
    k.lineTo(200, 124);
    k.moveTo(160, 84);
    k.lineTo(205, 124);
    k.lineTo(158, 166);
    k.stroke();
  });
  cell(2, 2, (k) => {
    k.fillStyle = "rgba(40,25,15,0.55)";
    k.beginPath();
    k.ellipse(128, 150, 34, 42, 0, 0, Math.PI * 2);
    k.fill();
    for (let f = 0; f < 5; f++) {
      k.beginPath();
      k.ellipse(84 + f * 22, 92 - Math.abs(f - 2) * 8, 8, 26, (f - 2) * 0.15, 0, Math.PI * 2);
      k.fill();
    }
    k.fillRect(110, 180, 30, 70);
  });
  cell(3, 2, (k) => {
    k.fillStyle = "rgba(30,20,12,0.7)";
    k.font = "bold 54px monospace";
    k.textAlign = "center";
    k.save();
    k.translate(128, 140);
    k.rotate(-0.08);
    k.fillText("NÃO", 0, 0);
    k.restore();
  });
  // Ceiling hole (dark void with a ragged rim).
  cell(0, 3, (k) => {
    k.fillStyle = "rgba(5,4,2,0.97)";
    k.fillRect(10, 10, 236, 236);
    k.fillStyle = "rgba(120,100,60,0.5)";
    for (let i = 0; i < 40; i++) k.fillRect(rng.range(8, 248), rng.chance(0.5) ? rng.range(6, 16) : rng.range(240, 250), 6, 4);
  });
  // Vent grille.
  cell(1, 3, (k) => {
    k.fillStyle = "rgba(150,145,130,1)";
    k.fillRect(16, 60, 224, 136);
    k.fillStyle = "rgba(20,18,14,1)";
    for (let y = 72; y < 186; y += 14) k.fillRect(28, y, 200, 7);
    k.strokeStyle = "rgba(60,55,45,1)";
    k.lineWidth = 4;
    k.strokeRect(16, 60, 224, 136);
  });
  return c;
}

function metalDoor(rng, { label = "" } = {}) {
  const { c, ctx } = canvas(256, 512);
  ctx.fillStyle = "#5d6458";
  ctx.fillRect(0, 0, 256, 512);
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 4;
  ctx.strokeRect(24, 30, 208, 200);
  ctx.strokeRect(24, 270, 208, 210);
  ctx.fillStyle = "#2a2a26";
  ctx.fillRect(200, 250, 36, 14);
  for (let i = 0; i < 60; i++) {
    ctx.strokeStyle = `rgba(200,200,190,${rng.range(0.05, 0.18)})`;
    ctx.lineWidth = 1;
    const x = rng.range(0, 256);
    const y = rng.range(0, 512);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + rng.range(-30, 30), y + rng.range(-8, 8));
    ctx.stroke();
  }
  for (let i = 0; i < 8; i++) blotch(ctx, rng.range(0, 256), rng.range(300, 512), rng.range(20, 50), "90,60,30", 0.25);
  if (label) {
    ctx.fillStyle = "rgba(230,230,220,0.85)";
    ctx.font = "bold 22px monospace";
    ctx.textAlign = "center";
    ctx.fillText(label, 128, 120);
  }
  noisePixels(ctx, 256, 512, 12, rng);
  return c;
}

function woodDoor(rng) {
  const { c, ctx } = canvas(256, 512);
  ctx.fillStyle = "#6f5133";
  ctx.fillRect(0, 0, 256, 512);
  for (let i = 0; i < 90; i++) {
    ctx.strokeStyle = `rgba(40,25,10,${rng.range(0.05, 0.2)})`;
    ctx.lineWidth = rng.range(1, 3);
    const x = rng.range(0, 256);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x + rng.range(-8, 8), 170, x + rng.range(-8, 8), 340, x + rng.range(-6, 6), 512);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(30,18,8,0.5)";
  ctx.lineWidth = 6;
  ctx.strokeRect(30, 40, 196, 180);
  ctx.strokeRect(30, 260, 196, 210);
  ctx.fillStyle = "#b9a874";
  ctx.beginPath();
  ctx.arc(212, 262, 10, 0, Math.PI * 2);
  ctx.fill();
  // Frame
  ctx.strokeStyle = "#4b3420";
  ctx.lineWidth = 16;
  ctx.strokeRect(0, 0, 256, 520);
  noisePixels(ctx, 256, 512, 14, rng);
  return c;
}

function signTexture(text, fg, bg) {
  const { c, ctx } = canvas(256, 96);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 256, 96);
  ctx.strokeStyle = fg;
  ctx.lineWidth = 4;
  ctx.strokeRect(6, 6, 244, 84);
  ctx.fillStyle = fg;
  ctx.font = "bold 50px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 52);
  return c;
}

function panelFace(rng) {
  const { c, ctx } = canvas(256, 340);
  ctx.fillStyle = "#7c817a";
  ctx.fillRect(0, 0, 256, 340);
  ctx.fillStyle = "#e3c22a";
  for (let i = -340; i < 256; i += 34) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 300, 256, 40);
    ctx.clip();
    ctx.translate(i, 300);
    ctx.rotate(-0.8);
    ctx.fillRect(0, 0, 14, 90);
    ctx.restore();
  }
  ctx.fillStyle = "#e9e5d4";
  ctx.fillRect(40, 30, 176, 54);
  ctx.fillStyle = "#1c1c1a";
  ctx.font = "bold 20px monospace";
  ctx.textAlign = "center";
  ctx.fillText("QUADRO 03", 128, 54);
  ctx.font = "13px monospace";
  ctx.fillText("ALTA TENSÃO", 128, 74);
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 3;
  ctx.strokeRect(10, 10, 236, 280);
  for (let i = 0; i < 30; i++) blotch(ctx, rng.range(0, 256), rng.range(0, 340), rng.range(8, 30), "90,60,30", 0.2);
  noisePixels(ctx, 256, 340, 12, rng);
  return c;
}

function cardboard(rng) {
  const { c, ctx } = canvas(256, 256);
  ctx.fillStyle = "#a07a4a";
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = "rgba(220,200,150,0.5)";
  ctx.fillRect(0, 112, 256, 32);
  for (let i = 0; i < 12; i++) blotch(ctx, rng.range(0, 256), rng.range(0, 256), rng.range(15, 50), "70,45,20", 0.2);
  ctx.fillStyle = "rgba(30,20,10,0.6)";
  ctx.font = "bold 22px monospace";
  ctx.fillText("ARQUIVO", 20, 60);
  noisePixels(ctx, 256, 256, 16, rng);
  return c;
}

function wetSign() {
  const { c, ctx } = canvas(128, 192);
  ctx.fillStyle = "#e5c21d";
  ctx.fillRect(0, 0, 128, 192);
  ctx.fillStyle = "#111";
  ctx.font = "bold 18px monospace";
  ctx.textAlign = "center";
  ctx.fillText("CUIDADO", 64, 34);
  ctx.font = "bold 13px monospace";
  ctx.fillText("PISO", 64, 150);
  ctx.fillText("MOLHADO", 64, 168);
  ctx.beginPath();
  ctx.moveTo(64, 52);
  ctx.lineTo(104, 124);
  ctx.lineTo(24, 124);
  ctx.closePath();
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.fillRect(60, 72, 8, 30);
  ctx.fillRect(60, 108, 8, 8);
  return c;
}

// Flashlight cookie: hot centre, soft falloff, faint ring and lens smudges.
function flashlightCookie(rng) {
  const S = 256;
  const { c, ctx } = canvas(S, S);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(250,248,240,0.95)");
  g.addColorStop(0.45, "rgba(200,195,180,0.55)");
  g.addColorStop(0.7, "rgba(150,145,130,0.35)");
  g.addColorStop(0.78, "rgba(185,180,165,0.42)");
  g.addColorStop(0.9, "rgba(60,58,50,0.12)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 9; i++) blotch(ctx, rng.range(50, 206), rng.range(50, 206), rng.range(10, 34), "0,0,0", 0.12);
  return c;
}

function vhsTapeLabel() {
  const { c, ctx } = canvas(128, 64);
  ctx.fillStyle = "#151515";
  ctx.fillRect(0, 0, 128, 64);
  ctx.fillStyle = "#ece6d0";
  ctx.fillRect(10, 8, 108, 24);
  ctx.fillStyle = "#802020";
  ctx.font = "bold 13px monospace";
  ctx.fillText("NÃO ASSISTA", 16, 25);
  ctx.fillStyle = "#333";
  ctx.fillRect(30, 38, 68, 18);
  return c;
}

export function createTextures(quality = "medium") {
  const rng = createRng("textures-v1");
  const aniso = quality === "high" ? 8 : quality === "medium" ? 4 : 1;
  const t = {
    wall: toTexture(wallpaper(rng), { aniso }),
    carpet: toTexture(carpet(rng), { aniso }),
    ceiling: toTexture(ceiling(rng), { aniso }),
    lamp: toTexture(lampPanel(), { repeat: false }),
    macro: toTexture(macroNoise(rng), { srgb: false, aniso: 1 }),
    decals: toTexture(decalAtlas(rng), { repeat: false, aniso }),
    metalDoor: toTexture(metalDoor(rng), { repeat: false }),
    woodDoor: toTexture(woodDoor(rng), { repeat: false }),
    exitSign: toTexture(signTexture("SAÍDA", "#ff3b2f", "#1a0605"), { repeat: false }),
    panel: toTexture(panelFace(rng), { repeat: false }),
    cardboard: toTexture(cardboard(rng), { aniso }),
    wetSign: toTexture(wetSign(), { repeat: false }),
    cookie: toTexture(flashlightCookie(rng), { repeat: false, aniso: 1 }),
    tapeLabel: toTexture(vhsTapeLabel(), { repeat: false }),
  };
  t.dispose = () => Object.values(t).forEach((x) => x?.isTexture && x.dispose());
  return t;
}

// Animated CRT static for the TV; only redrawn while the player is nearby.
export function createStaticScreen() {
  const W = 96;
  const H = 72;
  const { c, ctx } = canvas(W, H);
  const img = ctx.createImageData(W, H);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  let roll = 0;
  return {
    texture: tex,
    draw(mode) {
      const d = img.data;
      roll = (roll + 3) % H;
      for (let y = 0; y < H; y++) {
        const band = Math.abs(y - roll) < 4 ? 50 : 0;
        for (let x = 0; x < W; x++) {
          const o = (y * W + x) * 4;
          let v;
          if (mode === "off") v = 6;
          else if (mode === "blue") v = 0;
          else v = Math.random() * 200 + band;
          d[o] = mode === "blue" ? 20 : v;
          d[o + 1] = mode === "blue" ? 40 : v;
          d[o + 2] = mode === "blue" ? 160 : v * 1.05;
          d[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      tex.needsUpdate = true;
    },
    dispose: () => tex.dispose(),
  };
}
