import * as THREE from "three";
import { LIGHT_MAX, LIGHT_TEXEL } from "../game/lightfield.js";
import { WALL_HEIGHT } from "../game/grid.js";

// Shared uniforms + onBeforeCompile patch that adds the baked lamp field
// (see game/lightfield.js) and a world-space macro albedo variation to any
// MeshStandard/MeshLambert material. One texture fetch per fragment replaces
// hundreds of real lights; the macro noise hides texture tiling.

// One uniform set for the whole page; each run binds its own light field to it,
// so long-lived materials (creature, held flashlight) stay valid across restarts.
export function createLamp(macroTexture) {
  const placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
  placeholder.needsUpdate = true;
  let tex = null;
  let field = null;
  const uniforms = {
    uLampTex: { value: placeholder },
    uLampOrigin: { value: new THREE.Vector2() },
    uLampSize: { value: new THREE.Vector2(1, 1) },
    uLampGain: { value: 1 },
    uLampTint: { value: new THREE.Color(1, 1, 1) },
    uAmbient: { value: 0.012 },
    uMacroTex: { value: macroTexture },
    uMacroAmount: { value: 0.16 },
  };
  return {
    uniforms,
    bind(lightField) {
      tex?.dispose();
      field = lightField;
      tex = new THREE.DataTexture(lightField.bytes, lightField.sizeX, lightField.sizeZ, THREE.RGBAFormat);
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      lightField.encode();
      tex.needsUpdate = true;
      uniforms.uLampTex.value = tex;
      uniforms.uLampOrigin.value.set(lightField.originX, lightField.originZ);
      uniforms.uLampSize.value.set(lightField.sizeX * LIGHT_TEXEL, lightField.sizeZ * LIGHT_TEXEL);
      uniforms.uLampGain.value = 1;
    },
    upload() {
      if (!field) return;
      field.encode();
      tex.needsUpdate = true;
    },
    unbind() {
      tex?.dispose();
      tex = null;
      field = null;
      uniforms.uLampTex.value = placeholder;
    },
  };
}

const VERT_PARS = /* glsl */ `
varying vec3 vLampPos;
varying vec3 vLampNormal;
`;

const VERT_MAIN = /* glsl */ `
{
  vec4 lampWorld = vec4(transformed, 1.0);
  vec3 lampN = objectNormal;
  #ifdef USE_INSTANCING
    lampWorld = instanceMatrix * lampWorld;
    lampN = mat3(instanceMatrix) * lampN;
  #endif
  lampWorld = modelMatrix * lampWorld;
  vLampPos = lampWorld.xyz;
  vLampNormal = normalize(mat3(modelMatrix) * lampN);
}
`;

const FRAG_PARS = /* glsl */ `
uniform sampler2D uLampTex;
uniform vec2 uLampOrigin;
uniform vec2 uLampSize;
uniform float uLampGain;
uniform vec3 uLampTint;
uniform float uAmbient;
uniform sampler2D uMacroTex;
uniform float uMacroAmount;
varying vec3 vLampPos;
varying vec3 vLampNormal;

vec3 lampIrradiance() {
  // Sample slightly in front of the surface so each side of a thin wall reads its own room.
  vec2 p = vLampPos.xz + vLampNormal.xz * 0.3;
  vec3 s = texture2D(uLampTex, (p - uLampOrigin) / uLampSize).rgb;
  vec3 e = s * s * ${LIGHT_MAX.toFixed(2)};
  float h = clamp(vLampPos.y / ${WALL_HEIGHT.toFixed(2)}, 0.0, 1.0);
  float facing = vLampNormal.y < -0.5 ? 0.42 : (vLampNormal.y > 0.5 ? 1.0 : mix(0.78, 1.04, h));
  return e * facing * uLampGain * uLampTint + vec3(uAmbient);
}
`;

const FRAG_MACRO = /* glsl */ `
#include <color_fragment>
#ifdef LAMP_MACRO
{
  vec2 mp = vLampPos.xz * 0.025 + vec2(vLampPos.y * 0.013, -vLampPos.y * 0.009);
  float macro = texture2D(uMacroTex, mp).r * 0.65 + texture2D(uMacroTex, mp * 3.7).r * 0.35;
  diffuseColor.rgb *= 1.0 + (macro - 0.5) * uMacroAmount * 2.0;
}
#endif
`;

const FRAG_LIGHT = /* glsl */ `
#include <aomap_fragment>
reflectedLight.indirectDiffuse += diffuseColor.rgb * lampIrradiance();
`;

export function patchLampMaterial(material, lamp, { macro = false } = {}) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, lamp.uniforms);
    if (macro) shader.defines = { ...(shader.defines || {}), LAMP_MACRO: "" };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT_PARS}`)
      .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAG_PARS}`)
      .replace("#include <color_fragment>", FRAG_MACRO)
      .replace("#include <aomap_fragment>", FRAG_LIGHT);
  };
  // Distinct cache key so patched and unpatched programs never collide.
  material.customProgramCacheKey = () => `lamp-${macro ? 1 : 0}`;
  return material;
}
