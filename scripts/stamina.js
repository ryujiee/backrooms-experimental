import { clamp } from "./utils.js";

export function createStamina() {
  const max = 100;
  let value = max;

  function update(delta, isMoving, isSprinting) {
    if (isMoving && isSprinting && value > 0) {
      value -= delta * 24;
    } else if (!isSprinting || !isMoving) {
      value += delta * 18;
    }

    value = clamp(value, 0, max);

    return {
      value,
      max,
      canSprint: value > 5,
    };
  }

  return { update };
}
