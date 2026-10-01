import { createStamina } from "./stamina.js";

// First-person movement simulation (no rendering). Runs at the fixed step.

export const PLAYER = {
  radius: 0.3,
  walk: 2.6,
  sprint: 4.7,
  crouch: 1.3,
  accel: 13,
  decel: 17,
  eye: 1.62,
  eyeCrouch: 1.05,
  strideWalk: 1.3,
  strideSprint: 1.65,
  strideCrouch: 0.85,
  // Hearing radius (metres) of one footstep per gait; the creature hears these.
  noiseWalk: 7,
  noiseSprint: 17,
  noiseCrouch: 2,
};

export function createPlayer(collision, spawn) {
  const stamina = createStamina();
  const pos = { x: spawn.x, z: spawn.z };
  const prev = { x: spawn.x, z: spawn.z };
  const vel = { x: 0, z: 0 };
  let yaw = spawn.yaw;
  let pitch = 0;
  let crouch = 0;
  let stridePhase = 0;
  let distance = 0;
  let lastState = null;

  // input: { forward, right, sprint, crouch } with forward/right in [-1, 1]
  function step(dt, input, events) {
    prev.x = pos.x;
    prev.z = pos.z;

    let f = input.forward;
    let r = input.right;
    const len = Math.hypot(f, r);
    if (len > 1) {
      f /= len;
      r /= len;
    }
    const moving = len > 0.01;
    crouch += ((input.crouch ? 1 : 0) - crouch) * Math.min(1, dt * 8);
    const st = stamina.update(dt, { moving, wantsSprint: input.sprint && !input.crouch && f > 0 });
    const speed = moving ? (st.sprinting ? PLAYER.sprint : PLAYER.walk + (PLAYER.crouch - PLAYER.walk) * crouch) : 0;

    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // forward = (-sin, -cos), right = (cos, -sin)
    const tx = (-sin * f + cos * r) * speed;
    const tz = (-cos * f - sin * r) * speed;
    const rate = moving ? PLAYER.accel : PLAYER.decel;
    const k = Math.min(1, rate * dt);
    vel.x += (tx - vel.x) * k;
    vel.z += (tz - vel.z) * k;

    collision.moveCircle(pos, vel.x * dt, vel.z * dt, PLAYER.radius);
    // Velocity follows what actually happened, so pushing into a wall never builds up.
    const mx = pos.x - prev.x;
    const mz = pos.z - prev.z;
    const moved = Math.hypot(mx, mz);
    if (dt > 0) {
      vel.x = mx / dt;
      vel.z = mz / dt;
    }
    distance += moved;

    const stride = st.sprinting ? PLAYER.strideSprint : crouch > 0.5 ? PLAYER.strideCrouch : PLAYER.strideWalk;
    const groundSpeed = moved / Math.max(dt, 1e-6);
    if (groundSpeed > 0.4) {
      stridePhase += moved / stride;
      if (stridePhase >= 1) {
        stridePhase -= 1;
        const gait = st.sprinting ? "sprint" : crouch > 0.5 ? "crouch" : "walk";
        const radius = gait === "sprint" ? PLAYER.noiseSprint : gait === "crouch" ? PLAYER.noiseCrouch : PLAYER.noiseWalk;
        events?.push({ type: "footstep", gait, x: pos.x, z: pos.z, radius });
      }
    } else {
      stridePhase = Math.min(stridePhase, 0.6);
    }

    lastState = { moving: groundSpeed > 0.4, speed: groundSpeed, sprinting: st.sprinting, crouch, stamina: st };
    return lastState;
  }

  return {
    pos,
    prev,
    vel,
    step,
    get yaw() {
      return yaw;
    },
    set yaw(v) {
      yaw = v;
    },
    get pitch() {
      return pitch;
    },
    set pitch(v) {
      pitch = Math.max(-1.45, Math.min(1.45, v));
    },
    get crouch() {
      return crouch;
    },
    get stridePhase() {
      return stridePhase;
    },
    get distance() {
      return distance;
    },
    get state() {
      return lastState;
    },
    eyeHeight: () => PLAYER.eye + (PLAYER.eyeCrouch - PLAYER.eye) * crouch,
    teleport(x, z) {
      pos.x = prev.x = x;
      pos.z = prev.z = z;
      vel.x = vel.z = 0;
    },
  };
}
