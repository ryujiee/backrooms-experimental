// DOM layer: screens, settings form, HUD and VHS overlay. Bound once per page.
// HUD writes are cached so unchanged values never touch the DOM.

const $ = (id) => document.getElementById(id);

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  return `${h}:${m}:${String(s % 60).padStart(2, "0")}`;
}

export function createUI() {
  const screens = [...document.querySelectorAll(".screen")];
  const handlers = {};
  let current = "loading";
  let settingsReturn = "menu";
  const cache = new Map();
  const el = {
    hud: $("hud"),
    osd: $("osd"),
    osdTime: $("osd-time"),
    fade: $("fade"),
    objective: $("objective"),
    objectiveText: $("objective-text"),
    controlsHint: $("controls-hint"),
    prompt: $("prompt"),
    promptText: $("prompt-text"),
    promptFill: $("prompt-fill"),
    message: $("message"),
    subtitles: $("subtitles"),
    staminaRow: $("stamina-row"),
    staminaFill: $("stamina-fill"),
    batteryRow: $("battery-row"),
    batteryFill: $("battery-fill"),
    intro: $("intro"),
    introLines: $("intro-lines"),
    lockHint: $("lock-hint"),
    loadingFill: $("loading-fill"),
    loadingText: $("loading-text"),
    form: $("settings-form"),
  };
  let messageTimer = 0;
  let objectiveTimer = 0;
  let hintTimer = 0;

  const set = (key, value, apply) => {
    if (cache.get(key) === value) return;
    cache.set(key, value);
    apply(value);
  };

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "settings") {
      settingsReturn = current;
      show("settings");
    } else if (action === "controls" || action === "credits") {
      show(action);
    } else if (action === "back") {
      show(current === "settings" ? settingsReturn : "menu");
    }
    handlers[action]?.();
  });

  // Keyboard: Esc goes back from sub-screens.
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Escape") return;
    if (["settings", "controls", "credits"].includes(current)) {
      show(current === "settings" ? settingsReturn : "menu");
      handlers.back?.();
    }
  });

  function show(name) {
    current = name;
    screens.forEach((s) => s.classList.toggle("active", s.id === `screen-${name}`));
    const first = document.querySelector(`#screen-${name} button`);
    if (first && name !== "loading") first.focus({ preventScroll: true });
  }

  function hideScreens() {
    current = null;
    screens.forEach((s) => s.classList.remove("active"));
  }

  function bindSettings(settings, onChange) {
    const form = el.form;
    const write = () => {
      for (const [k, v] of Object.entries(settings)) {
        const input = form.elements[k];
        if (!input) continue;
        if (input.type === "checkbox") input.checked = v;
        else input.value = v;
        const out = form.querySelector(`output[data-for="${k}"]`);
        if (out) out.textContent = k === "fov" ? `${v}°` : k === "sensitivity" ? `${(v / 100).toFixed(1)}x` : `${v}`;
      }
    };
    write();
    form.addEventListener("input", (e) => {
      const input = e.target;
      const name = input.name;
      if (!name) return;
      const value = input.type === "checkbox" ? input.checked : input.type === "range" ? Number(input.value) : input.value;
      onChange({ [name]: value });
      write();
    });
    form.addEventListener("submit", (e) => e.preventDefault());
    return { refresh: write };
  }

  return {
    on(action, fn) {
      handlers[action] = fn;
    },
    show,
    hideScreens,
    get screen() {
      return current;
    },
    bindSettings,
    setLoading(progress, text) {
      el.loadingFill.style.width = `${Math.round(progress * 100)}%`;
      if (text) el.loadingText.textContent = text;
    },
    setMenuStats(stats) {
      const parts = [];
      if (stats.completed && stats.bestTime) parts.push(`Melhor tempo: ${formatTime(stats.bestTime)}`);
      if (stats.runs) parts.push(`Tentativas: ${stats.runs}`);
      $("menu-stats").textContent = parts.join("  ·  ");
    },
    setFullscreenLabel(isFull) {
      $("fullscreen-btn").textContent = isFull ? "SAIR DA TELA CHEIA" : "TELA CHEIA";
    },
    setRetryLabel(hasCheckpoint) {
      document.querySelector('#screen-dead [data-action="retry"]').textContent = hasCheckpoint ? "VOLTAR AO ÚLTIMO OBJETIVO" : "TENTAR DE NOVO";
      document.querySelector('#screen-dead [data-action="restartfull"]').classList.toggle("hidden", !hasCheckpoint);
    },
    setPauseObjective(text) {
      $("pause-objective").textContent = text ? `Objetivo: ${text}` : "";
    },
    showError(text) {
      $("error-text").textContent = text;
      show("error");
    },
    setEndStats(kind, rows) {
      const target = $(kind === "win" ? "win-stats" : "dead-stats");
      target.innerHTML = "";
      const dl = document.createElement("dl");
      dl.className = "stats";
      for (const [k, v] of rows) {
        const dt = document.createElement("dt");
        dt.textContent = k;
        const dd = document.createElement("dd");
        dd.textContent = v;
        dl.append(dt, dd);
      }
      target.append(...dl.childNodes);
    },

    // --- HUD ---
    setHudVisible(v) {
      set("hud", v, (x) => {
        el.hud.classList.toggle("hidden", !x);
        el.osd.classList.toggle("hidden", !x);
      });
    },
    setFade(alpha) {
      set("fade", Math.round(alpha * 100) / 100, (x) => (el.fade.style.opacity = String(x)));
    },
    setFadeColor(color) {
      set("fadeColor", color, (x) => (el.fade.style.background = x));
    },
    setOsdTime(seconds) {
      set("osd", Math.floor(seconds), (x) => (el.osdTime.textContent = formatTime(x)));
    },
    setObjective(text, showFor = 7) {
      set("objective", text, (x) => (el.objectiveText.textContent = x));
      objectiveTimer = showFor;
    },
    peekObjective(holding) {
      if (holding) objectiveTimer = Math.max(objectiveTimer, 0.3);
    },
    setControlsHint(text, seconds) {
      el.controlsHint.textContent = text;
      hintTimer = seconds;
    },
    setPrompt(text, progress) {
      set("prompt", text || "", (x) => {
        el.prompt.classList.toggle("hidden", !x);
        el.promptText.textContent = x;
      });
      set("promptHold", progress > 0, (x) => el.prompt.classList.toggle("holding", x));
      set("promptFill", Math.round((progress || 0) * 100), (x) => (el.promptFill.style.width = `${x}%`));
    },
    message(text, seconds = 3) {
      el.message.textContent = text;
      el.message.classList.add("show");
      messageTimer = seconds;
    },
    subtitle(text, seconds = 3.5) {
      const div = document.createElement("div");
      div.className = "sub";
      div.textContent = text;
      el.subtitles.append(div);
      while (el.subtitles.children.length > 3) el.subtitles.firstChild.remove();
      setTimeout(() => div.remove(), seconds * 1000);
    },
    setMeters(stamina, staminaVisible, battery, batteryVisible) {
      set("stamina", Math.round(stamina), (x) => (el.staminaFill.style.transform = `scaleX(${x / 100})`));
      set("staminaShow", staminaVisible, (x) => el.staminaRow.classList.toggle("show", x));
      set("staminaLow", stamina < 25, (x) => el.staminaRow.classList.toggle("low", x));
      set("battery", Math.round(battery), (x) => (el.batteryFill.style.transform = `scaleX(${x / 100})`));
      set("batteryShow", batteryVisible, (x) => el.batteryRow.classList.toggle("show", x));
      set("batteryLow", battery < 20, (x) => el.batteryRow.classList.toggle("low", x));
    },
    tick(dt) {
      if (messageTimer > 0) {
        messageTimer -= dt;
        if (messageTimer <= 0) el.message.classList.remove("show");
      }
      objectiveTimer -= dt;
      set("objShow", objectiveTimer > 0, (x) => el.objective.classList.toggle("show", x));
      hintTimer -= dt;
      set("hintShow", hintTimer > 0, (x) => el.controlsHint.classList.toggle("show", x));
    },
    clearHud() {
      el.subtitles.innerHTML = "";
      el.message.classList.remove("show");
      messageTimer = 0;
      objectiveTimer = 0;
      hintTimer = 0;
      this.setPrompt(null, 0);
    },

    // --- intro ---
    showIntro(lines) {
      el.introLines.innerHTML = "";
      el.intro.classList.remove("hidden");
      lines.forEach((l) => {
        const div = document.createElement("div");
        div.className = `line${l.small ? " small" : ""}`;
        div.textContent = l.text;
        div.style.animationDelay = `${l.at}s`;
        el.introLines.append(div);
      });
    },
    hideIntro() {
      el.intro.classList.add("hidden");
    },
    setLockHint(v) {
      set("lockHint", v, (x) => el.lockHint.classList.toggle("hidden", !x));
    },
  };
}
