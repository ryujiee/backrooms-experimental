import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { log } from "./log.js";

// Preloads the two models and the audio samples with real byte/count progress.
// Any single failure resolves to null and the game uses a fallback instead.

const MODELS = {
  flashlight: "assets/models/old_flashlight.glb",
  monster: "assets/models/bacteria_lifeform_backrooms.glb",
};

export async function loadAssets(audio, onProgress) {
  const loader = new GLTFLoader();
  const parts = { flashlight: 0, monster: 0, audio: 0 };
  const report = () => onProgress?.((parts.flashlight + parts.monster + parts.audio) / 3);

  const loadModel = (key) =>
    loader
      .loadAsync(MODELS[key], (e) => {
        if (e.lengthComputable && e.total) {
          parts[key] = Math.min(0.99, e.loaded / e.total);
          report();
        }
      })
      .then((gltf) => gltf.scene)
      .catch((err) => {
        log.warn(`model "${key}" failed to load, using fallback`, err);
        return null;
      })
      .finally(() => {
        parts[key] = 1;
        report();
      });

  const [flashlight, monster] = await Promise.all([
    loadModel("flashlight"),
    loadModel("monster"),
    audio.preload((p) => {
      parts.audio = p;
      report();
    }),
  ]);
  return { flashlight, monster };
}
