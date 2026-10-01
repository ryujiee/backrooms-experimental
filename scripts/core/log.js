// Dev-only diagnostics. Production builds stay quiet unless something is fatal.
const DEV = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env.DEV : true;

export const log = {
  warn: (...args) => DEV && console.warn("[backrooms]", ...args),
  info: (...args) => DEV && console.info("[backrooms]", ...args),
  error: (...args) => console.error("[backrooms]", ...args),
};
