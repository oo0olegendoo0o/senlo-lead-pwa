// api/auth.js
// POST { code } -> validates the PIN server-side, returns the tenant's display
// name + accent + a short-lived signed token. The token carries the tenant id
// and rep label so subsequent /extract and /send calls don't re-prompt for the
// PIN. The browser never receives the PIN list or any webhook.
//
// Token note: this is a lightweight HMAC-signed token (not a full JWT lib) so
// there are no dependencies. It proves "this session passed a valid PIN" and
// names the tenant. It is NOT a hardened auth system — see _tenants.js for the
// deferred-hardening note.

import crypto from "node:crypto";
import { resolveTenant } from "./_tenants.js";

const TOKEN_SECRET = process.env.TOKEN_SECRET || "dev-only-secret-change-me";
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h — covers a shift

export function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
  // timing-safe compare
  const a = Buffer.from(sig || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload?.exp || Date.now() > payload.exp) return null;
  return payload;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const { code } = req.body || {};
  const resolved = resolveTenant(code);

  // Uniform response time-ish + generic message on failure (don't reveal which
  // part was wrong, don't confirm tenant existence).
  if (!resolved) {
    res.status(401).json({ ok: false, error: "Invalid code" });
    return;
  }

  const token = signToken({
    tid: resolved.tenant.id,
    rep: resolved.repLabel,
    exp: Date.now() + TOKEN_TTL_MS,
  });

  res.status(200).json({
    ok: true,
    tenant: { id: resolved.tenant.id, name: resolved.tenant.name, accent: resolved.tenant.accent },
    rep: resolved.repLabel,
    token,
  });
}
