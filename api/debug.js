// api/debug.js
// TEMPORARY diagnostic. Reports whether env vars are present at runtime,
// WITHOUT revealing their values. Delete this file after debugging.
// Visit /api/debug in the browser.

export default function handler(req, res) {
  const report = {
    ANTHROPIC_API_KEY: {
      set: typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.length > 0,
      length: (process.env.ANTHROPIC_API_KEY || "").length,
    },
    TOKEN_SECRET: {
      set: typeof process.env.TOKEN_SECRET === "string" && process.env.TOKEN_SECRET.length > 0,
      length: (process.env.TOKEN_SECRET || "").length,
    },
    CS_MAZDA_PIN: {
      set: typeof process.env.CS_MAZDA_PIN === "string" && process.env.CS_MAZDA_PIN.length > 0,
      length: (process.env.CS_MAZDA_PIN || "").length,
      // show ONLY the length and whether it equals 4 chars — not the value
      looksLikePin: /^\d{4}$/.test(process.env.CS_MAZDA_PIN || ""),
      // reveal first+last char only, to catch stray spaces/quotes without leaking
      firstChar: (process.env.CS_MAZDA_PIN || "").slice(0, 1) || null,
      lastChar: (process.env.CS_MAZDA_PIN || "").slice(-1) || null,
    },
    nodeVersion: process.version,
  };
  res.status(200).json(report);
}
