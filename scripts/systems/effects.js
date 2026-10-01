import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

// Final image: optional bloom, tone mapping, then one VHS pass (grain, scanlines,
// light chromatic aberration, vignette, rare tracking errors, stress desaturation,
// flashes and fades). Kept subtle by default so the picture stays readable.
// LOW quality renders directly and uses the CSS fade/vignette fallback.

const VHSShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uGrain: { value: 0.045 },
    uVignette: { value: 0.55 },
    uChroma: { value: 0.0018 },
    uScan: { value: 0.035 },
    uTracking: { value: 0 },
    uDesat: { value: 0 },
    uExposure: { value: 1 },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(0.6, 0.02, 0.02) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uGrain, uVignette, uChroma, uScan, uTracking, uDesat, uExposure, uFlash;
    uniform vec3 uFlashColor;
    varying vec2 vUv;
    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      float band = 0.0;
      if (uTracking > 0.001) {
        float row = floor((uv.y + uTime * 0.21) * 22.0);
        float hit = step(0.93 - uTracking * 0.2, rand(vec2(row, floor(uTime * 14.0))));
        band = hit * (rand(vec2(row, uTime)) - 0.5) * 0.06 * uTracking;
        uv.x += band + sin(uv.y * 220.0 + uTime * 35.0) * 0.0012 * uTracking;
      }
      vec2 dir = uv - 0.5;
      float dist = length(dir);
      vec2 off = dir * (uChroma + uTracking * 0.004) * (0.3 + dist * 1.6);
      vec3 col = vec3(texture2D(tDiffuse, uv + off).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - off).b);
      col *= uExposure;
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(l) * vec3(1.02, 1.0, 0.94), uDesat);
      col *= 1.0 - uScan * (0.5 + 0.5 * sin(gl_FragCoord.y * 3.14159));
      col += (rand(gl_FragCoord.xy * 0.71 + fract(uTime * 7.31) * 113.0) - 0.5) * uGrain;
      col *= mix(1.0, smoothstep(0.92, 0.28, dist), uVignette);
      col += abs(band) * 5.0;
      col = mix(col, uFlashColor, uFlash);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export function createEffects(renderer, scene, camera) {
  let composer = null;
  let vhs = null;
  let bloom = null;
  let preset = null;
  const state = { stress: 0, tracking: 0, flash: 0, exposure: 1, chromaBoost: 0 };

  function build(p) {
    dispose();
    preset = p;
    if (!p.post) return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: p.msaa });
    composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));
    if (p.bloom) {
      bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.32, 0.45, 0.82);
      composer.addPass(bloom);
    }
    composer.addPass(new OutputPass());
    vhs = new ShaderPass(VHSShader);
    composer.addPass(vhs);
  }

  function dispose() {
    if (!composer) return;
    composer.passes.forEach((pass) => pass.dispose?.());
    composer.renderTarget1.dispose();
    composer.renderTarget2.dispose();
    composer = null;
    vhs = null;
    bloom = null;
  }

  return {
    setPreset: build,
    get enabled() {
      return !!composer;
    },
    setSize(w, h) {
      composer?.setPixelRatio(renderer.getPixelRatio());
      composer?.setSize(w, h);
    },
    // stress 0..1 (desaturation + vignette), tracking 0..1 (glitch), flash 0..1 (red hit), exposure.
    set(values) {
      Object.assign(state, values);
    },
    render(time, reduceMotion) {
      if (!composer) {
        renderer.render(scene, camera);
        return;
      }
      const u = vhs.uniforms;
      u.uTime.value = time;
      u.uDesat.value = Math.min(0.55, state.stress * 0.45);
      u.uVignette.value = 0.5 + state.stress * 0.35;
      u.uTracking.value = reduceMotion ? state.tracking * 0.3 : state.tracking;
      u.uChroma.value = 0.0016 + state.chromaBoost * 0.01;
      u.uFlash.value = state.flash;
      u.uExposure.value = state.exposure;
      composer.render();
    },
    dispose,
  };
}
