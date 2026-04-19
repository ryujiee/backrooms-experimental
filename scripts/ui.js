export function createUI() {
  const overlay = document.getElementById("overlay");
  const startBtn = document.getElementById("startBtn");
  const optionsBtn = document.getElementById("optionsBtn");
  const exitBtn = document.getElementById("exitBtn");
  const backBtn = document.getElementById("backBtn");
  const restartBtn = document.getElementById("restartBtn");
  const menuBtn = document.getElementById("menuBtn");
  const continueBtn = document.getElementById("continueBtn");
  const pauseMenuBtn = document.getElementById("pauseMenuBtn");
  const menuMain = document.getElementById("menuMain");
  const menuOptions = document.getElementById("menuOptions");
  const menuGameOver = document.getElementById("menuGameOver");
  const menuPause = document.getElementById("menuPause");
  const masterVolume = document.getElementById("masterVolume");
  const sfxVolume = document.getElementById("sfxVolume");
  const mouseSensitivity = document.getElementById("mouseSensitivity");
  const loading = document.getElementById("loading");
  const staminaFill = document.getElementById("staminaFill");
  const message = document.getElementById("message");

  let startCallback = () => {};
  let exitCallback = () => {};
  let restartCallback = () => {};
  let menuCallback = () => {};
  let continueCallback = () => {};
  let pauseMenuCallback = () => {};
  let audioRef = null;
  let controlsRef = null;

  function setStamina(value, max) {
    const pct = Math.max(0, Math.min(1, value / max));
    staminaFill.style.width = `${Math.round(pct * 100)}%`;
  }

  function showMessage(text) {
    message.textContent = text;
    message.classList.remove("hidden");
  }

  function hideMessage() {
    message.classList.add("hidden");
  }

  function showOverlay() {
    overlay.classList.add("visible");
    overlay.classList.remove("hidden");
  }

  function hideOverlay() {
    overlay.classList.add("hidden");
    overlay.classList.remove("visible");
  }

  function onStart(cb) {
    startCallback = cb;
  }

  startBtn.addEventListener("click", () => {
    hideMessage();
    startCallback();
  });

  if (optionsBtn && backBtn && menuMain && menuOptions) {
    optionsBtn.addEventListener("click", () => {
      menuMain.classList.add("hidden");
      menuOptions.classList.remove("hidden");
    });

    backBtn.addEventListener("click", () => {
      menuOptions.classList.add("hidden");
      menuMain.classList.remove("hidden");
    });
  }

  if (restartBtn) {
    restartBtn.addEventListener("click", () => restartCallback());
  }

  if (menuBtn) {
    menuBtn.addEventListener("click", () => menuCallback());
  }

  if (continueBtn) {
    continueBtn.addEventListener("click", () => continueCallback());
  }

  if (pauseMenuBtn) {
    pauseMenuBtn.addEventListener("click", () => pauseMenuCallback());
  }

  if (exitBtn) {
    exitBtn.addEventListener("click", () => exitCallback());
  }

  if (masterVolume) {
    masterVolume.addEventListener("input", (e) => {
      if (!audioRef) return;
      audioRef.setMasterVolume(e.target.value / 100);
    });
  }

  if (sfxVolume) {
    sfxVolume.addEventListener("input", (e) => {
      if (!audioRef) return;
      audioRef.setSfxVolume(e.target.value / 100);
    });
  }

  if (mouseSensitivity) {
    mouseSensitivity.addEventListener("input", (e) => {
      if (!controlsRef) return;
      controlsRef.setSensitivity(e.target.value / 100);
    });
  }

  function setStress(level) {
    const intensity = Math.round(40 * level);
    document.body.style.filter = `saturate(${100 - intensity}%)`;
  }

  function setLoading(isLoading, text) {
    if (!loading) return;
    loading.textContent = text || (isLoading ? "Carregando..." : "");
    loading.style.display = isLoading ? "block" : "none";
    startBtn.disabled = isLoading;
  }

  function onExit(cb) {
    exitCallback = cb;
  }

  function onRestart(cb) {
    restartCallback = cb;
  }

  function onMenu(cb) {
    menuCallback = cb;
  }

  function onContinue(cb) {
    continueCallback = cb;
  }

  function onPauseMenu(cb) {
    pauseMenuCallback = cb;
  }

  function showGameOver() {
    if (!menuGameOver || !menuMain || !menuOptions) return;
    menuMain.classList.add("hidden");
    menuOptions.classList.add("hidden");
    if (menuPause) menuPause.classList.add("hidden");
    menuGameOver.classList.remove("hidden");
    showOverlay();
  }

  function showMainMenu() {
    if (!menuGameOver || !menuMain || !menuOptions) return;
    menuGameOver.classList.add("hidden");
    menuOptions.classList.add("hidden");
    if (menuPause) menuPause.classList.add("hidden");
    menuMain.classList.remove("hidden");
    showOverlay();
  }

  function showPause() {
    if (!menuPause || !menuMain || !menuOptions || !menuGameOver) return;
    menuMain.classList.add("hidden");
    menuOptions.classList.add("hidden");
    menuGameOver.classList.add("hidden");
    menuPause.classList.remove("hidden");
    showOverlay();
  }

  function hidePause() {
    if (!menuPause) return;
    menuPause.classList.add("hidden");
    hideOverlay();
  }

  function bindAudio(audio) {
    audioRef = audio;
  }

  function bindControls(controls) {
    controlsRef = controls;
  }

  return {
    setStamina,
    showMessage,
    hideMessage,
    showOverlay,
    hideOverlay,
    onStart,
    onExit,
    onRestart,
    onMenu,
    onContinue,
    onPauseMenu,
    showGameOver,
    showMainMenu,
    showPause,
    hidePause,
    bindAudio,
    bindControls,
    setStress,
    setLoading,
  };
}
