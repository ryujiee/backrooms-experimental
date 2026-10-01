// Quality presets and a conservative automatic pick (no benchmark: GPU string +
// screen size + memory hints, then one optional step down if frames are slow).

export const PRESETS = {
  low: { name: "low", pixelRatio: 0.75, maxPixelRatio: 1, shadows: false, shadowSize: 0, poolLights: 2, post: false, bloom: false, msaa: 0, far: 48, fog: 0.05, antialias: true },
  medium: { name: "medium", pixelRatio: 1, maxPixelRatio: 1, shadows: true, shadowSize: 512, poolLights: 3, post: true, bloom: false, msaa: 2, far: 62, fog: 0.04, antialias: false },
  high: { name: "high", pixelRatio: 1, maxPixelRatio: 1.5, shadows: true, shadowSize: 1024, poolLights: 5, post: true, bloom: true, msaa: 4, far: 80, fog: 0.034, antialias: false },
};

export function gpuInfo(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    return "";
  }
}

export function autoPreset(renderer) {
  const gpu = gpuInfo(renderer).toLowerCase();
  const pixels = window.screen.width * window.screen.height * Math.min(2, window.devicePixelRatio || 1) ** 2;
  if (/swiftshader|llvmpipe|software|basic render|mali|adreno|powervr/.test(gpu)) return "low";
  if (/nvidia|geforce|rtx|gtx|radeon rx|radeon pro|apple m\d|apple gpu/.test(gpu)) return pixels > 3840 * 2160 ? "medium" : "high";
  if ((navigator.deviceMemory && navigator.deviceMemory <= 4) || (navigator.hardwareConcurrency || 8) <= 4) return "low";
  return "medium";
}

export function resolvePreset(setting, renderer) {
  return PRESETS[setting === "auto" ? autoPreset(renderer) : setting] || PRESETS.medium;
}

// Rolling frame-time monitor used only in "auto" mode to step down once.
export function createFrameMonitor() {
  let samples = 0;
  let sum = 0;
  let warmup = 4;
  return {
    sample(dt) {
      if (warmup > 0) {
        warmup -= dt;
        return null;
      }
      samples++;
      sum += dt;
      if (samples < 300) return null;
      const avg = sum / samples;
      samples = 0;
      sum = 0;
      return avg;
    },
    reset() {
      samples = 0;
      sum = 0;
      warmup = 4;
    },
  };
}
