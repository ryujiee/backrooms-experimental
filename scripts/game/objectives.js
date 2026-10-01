// Linear three-step progression plus the escape. Each completed step raises the
// threat stage. Pure logic: the session feeds positions and input, and reacts to
// the returned `completed` / `message` values.

export const STEPS = [
  { id: "power", text: "Encontre o quadro de energia.", hold: 3.2, prompt: "Segure [E] para religar a energia" },
  { id: "tape", text: "Encontre a fita.", hold: 0, prompt: "[E] Pegar a fita" },
  { id: "exit", text: "Encontre a porta com a luz vermelha.", hold: 3.2, prompt: "Segure [E] para forçar a porta" },
  { id: "escape", text: "A porta está abrindo. Sobreviva.", duration: 25 },
  { id: "leave", text: "Saia. Agora." },
];

const REACH = 1.9;
const FACING = 0.5;

export function createObjectives(points) {
  // points: { power: {x,z}, tape: {x,z}, exit: {x,z} }
  let step = 0;
  let hold = 0;
  let escapeTime = 0;
  let lockedMessageCooldown = 0;
  const done = [];

  function current() {
    return STEPS[step];
  }

  function facingTarget(player, t) {
    const dx = t.x - player.x;
    const dz = t.z - player.z;
    const d = Math.hypot(dx, dz);
    if (d > REACH) return false;
    if (d < 0.6) return true;
    return (dx * player.fx + dz * player.fz) / d > FACING;
  }

  // player: { x, z, fx, fz } (fx/fz = horizontal forward); input: { pressed, held }
  function update(dt, player, input) {
    const out = { prompt: null, progress: 0, completed: null, message: null };
    lockedMessageCooldown = Math.max(0, lockedMessageCooldown - dt);
    const s = current();

    if (s.id === "escape") {
      escapeTime += dt;
      out.progress = Math.min(1, escapeTime / s.duration);
      if (escapeTime >= s.duration) {
        done.push("escape");
        step++;
        out.completed = "escape";
      }
      return out;
    }
    if (s.id === "leave") return out;

    // Visiting the door too early explains itself without blocking anything.
    if (s.id !== "exit" && facingTarget(player, points.exit)) {
      out.prompt = "[E] Porta";
      if (input.pressed && lockedMessageCooldown <= 0) {
        lockedMessageCooldown = 2;
        out.message = s.id === "power" ? "Trancada. Não há energia." : "Trancada. Falta alguma coisa.";
      }
      return out;
    }

    const target = points[s.id];
    if (!target || !facingTarget(player, target)) {
      hold = Math.max(0, hold - dt * 2);
      return out;
    }
    out.prompt = s.prompt;
    if (s.hold > 0) {
      if (input.held) hold += dt;
      else hold = Math.max(0, hold - dt * 2);
      out.progress = Math.min(1, hold / s.hold);
      if (hold >= s.hold) {
        hold = 0;
        done.push(s.id);
        step++;
        out.completed = s.id;
      }
    } else if (input.pressed) {
      done.push(s.id);
      step++;
      out.completed = s.id;
    }
    return out;
  }

  return {
    update,
    get step() {
      return step;
    },
    get current() {
      return current();
    },
    get completedCount() {
      return Math.min(3, done.filter((id) => id !== "escape").length);
    },
    get holding() {
      return hold > 0;
    },
    isDone: (id) => done.includes(id),
    // Debug / QA helper.
    skipTo(index) {
      while (step < index) done.push(STEPS[step++].id);
    },
  };
}
