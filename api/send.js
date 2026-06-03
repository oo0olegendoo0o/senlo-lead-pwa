// api/send.js
// POST { token, fields } -> re-validates the rep-confirmed fields server-side,
// builds the exact payload that goes to GHL, and POSTs it to the tenant webhook.
//
// Why re-validate here: never trust the client. The rep may have edited fields;
// we re-run the same deterministic checks so a bad mobile can't slip through.

import { validate } from "./_extract-core.js";
import { verifyToken } from "./auth.js";
import { getTenantById } from "./_tenants.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { token, fields } = req.body || {};

  const session = verifyToken(token);
  if (!session) {
    res.status(401).json({ ok: false, error: "Session expired — enter your code again" });
    return;
  }

  if (!fields) {
    res.status(400).json({ ok: false, error: "Missing fields" });
    return;
  }

  // Re-validate server-side (client is never trusted).
  const v = validate(fields);
  if (!v.canSend) {
    res.status(422).json({ ok: false, error: "Not contactable — needs a valid mobile or email" });
    return;
  }

  const tenant = getTenantById(session.tid);

  // Build the clean payload GHL will receive. Values come from the VALIDATED
  // checks (normalised mobile, lowercased email, cleaned car), not raw input.
  const payload = {
    tenant: tenant?.id || session.tid,
    submittedBy: session.rep || "Showroom", // "Showroom" (shared) or rep name (per-rep)
    name: v.checks.name.value,
    mobile: v.checks.mobile.value,
    email: v.checks.email.value,
    car: v.checks.car.value,
    postcode: v.checks.postcode.value,
    comment: v.comment,
    // Routing flags that tell GHL how to open the conversation.
    channel: v.flags.channel, // "sms" | "email"
    hasName: v.flags.hasName, // false -> generic opener
    hasCar: v.flags.hasCar, // false -> bot asks which vehicle
    emailOnly: v.flags.emailOnly,
    prefersText: v.flags.prefersText,
    source: "autogate-screenshot",
    submittedAt: new Date().toISOString(),
  };

  // ── Stage 3: real POST to the tenant's GHL webhook ──
  if (!tenant?.webhook) {
    res.status(500).json({ ok: false, error: "No webhook configured for this tenant" });
    return;
  }

  let delivered = false;
  try {
    const ghlRes = await fetch(tenant.webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    delivered = ghlRes.ok;
    if (!ghlRes.ok) {
      const text = await ghlRes.text();
      console.error("GHL webhook non-200:", ghlRes.status, text);
    }
  } catch (err) {
    console.error("GHL webhook POST failed:", err);
    res.status(502).json({ ok: false, error: "Could not reach GHL — try again" });
    return;
  }

  res.status(200).json({
    ok: true,
    delivered,
    payload,
  });
}
