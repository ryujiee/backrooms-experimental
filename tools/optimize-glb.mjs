// One-off asset optimizer: downsizes embedded GLB textures (via ffmpeg) and
// strips KHR_materials_transmission, which forces an extra render pass in three.js.
// Usage: node tools/optimize-glb.mjs <in.glb> <out.glb> [maxSize=512]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [input, output, sizeArg] = process.argv.slice(2);
const maxSize = Number(sizeArg) || 512;
const glb = fs.readFileSync(input);
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString());
const binStart = 20 + jsonLen + 8;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glb-"));

const viewData = (bv) =>
  glb.subarray(binStart + (bv.byteOffset || 0), binStart + (bv.byteOffset || 0) + bv.byteLength);

// Drop transmission; the flashlight reads fine as an opaque, double-sided mesh.
const transmissionTextures = new Set();
for (const mat of json.materials || []) {
  const ext = mat.extensions?.KHR_materials_transmission;
  if (ext?.transmissionTexture) transmissionTextures.add(ext.transmissionTexture.index);
  if (mat.extensions) delete mat.extensions.KHR_materials_transmission;
  if (mat.alphaMode === "BLEND") mat.alphaMode = "OPAQUE";
}
json.extensionsUsed = (json.extensionsUsed || []).filter((e) => e !== "KHR_materials_transmission");
if (!json.extensionsUsed.length) delete json.extensionsUsed;

const chunks = [];
let offset = 0;
const newViews = [];
function pushView(data, view) {
  const pad = (4 - (offset % 4)) % 4;
  if (pad) chunks.push(Buffer.alloc(pad)), (offset += pad);
  chunks.push(data);
  newViews.push({ ...view, byteOffset: offset, byteLength: data.length });
  offset += data.length;
}

const imageViews = new Map((json.images || []).map((img, i) => [img.bufferView, i]));
json.bufferViews.forEach((bv, index) => {
  if (!imageViews.has(index)) return pushView(viewData(bv), bv);
  const imgIndex = imageViews.get(index);
  const src = path.join(tmp, `in${imgIndex}.png`);
  const dst = path.join(tmp, `out${imgIndex}.jpg`);
  fs.writeFileSync(src, viewData(bv));
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", src, "-vf", `scale=${maxSize}:-1`, "-q:v", "3", dst]);
  json.images[imgIndex].mimeType = "image/jpeg";
  const { name, ...rest } = bv;
  pushView(fs.readFileSync(dst), { ...rest, name: (name || "image").replace(/\.png$/, ".jpg") });
});
json.bufferViews = newViews;

// Unreference transmission textures (image data is tiny after resize; kept to preserve indices).
for (const tex of transmissionTextures) json.textures[tex].name = "unused";

const bin = Buffer.concat(chunks);
const binPadded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
json.buffers = [{ byteLength: binPadded.length }];
let jsonBuf = Buffer.from(JSON.stringify(json));
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binPadded.length, 8);
const chunkHeader = (len, type) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(len, 0);
  h.writeUInt32LE(type, 4);
  return h;
};
fs.writeFileSync(
  output,
  Buffer.concat([header, chunkHeader(jsonBuf.length, 0x4e4f534a), jsonBuf, chunkHeader(binPadded.length, 0x004e4942), binPadded])
);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${input} (${glb.length} B) -> ${output} (${fs.statSync(output).size} B)`);
