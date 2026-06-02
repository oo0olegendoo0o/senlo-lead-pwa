// api/_tenants.js
// SERVER-SIDE ONLY. This file runs inside Vercel serverless functions and is
// NEVER shipped to the browser. The PWA front-end never sees this list, any
// PIN, or any webhook URL — it only ever sends a PIN to the backend and gets
// back a tenant's display name + branding. That is what makes the PIN gate a
// real (if minimal) security boundary rather than a cosmetic one.
//
// ── How tenancy resolves ────────────────────────────────────────────────────
// A rep enters a code. resolveTenant(code) looks it up here and returns the
// matching tenant (name, GHL webhook, branding) or null. The code can map to:
//   - a whole dealership (shared PIN — what the pilot uses), or
//   - an individual rep (per-rep PIN — supported by the shape below, OFF for
//     now; flip it on later for lead attribution without a rewrite).
//
// ── Where real values live in production ────────────────────────────────────
// Do NOT hardcode real PINs or webhook URLs in the repo. In Vercel, set them as
// Environment Variables and read them via process.env (see below). The defaults
// here are placeholders so the thing runs locally before GHL exists.
//
// ── What this is NOT yet (deferred hardening, by design) ─────────────────────
// No PIN attempt rate-limiting, no lockout, no session expiry. Fine for a
// single-tenant pilot; REQUIRED before multiple real dealerships rely on it.
// Tracked here so it isn't forgotten.

// Pull secrets from env when present, fall back to pilot placeholders.
const CS_MAZDA_PIN = process.env.CS_MAZDA_PIN || "4321"; // change in Vercel env
const CS_MAZDA_GHL_WEBHOOK = process.env.CS_MAZDA_GHL_WEBHOOK || null; // set in Stage 3

// Tenant registry. Add a dealership = add an entry. Each tenant owns:
//   id        - internal slug
//   name      - display name shown to the rep after a valid PIN
//   accent    - optional brand accent (defaults to Senlo blue)
//   webhook   - that tenant's GHL inbound webhook (null until Stage 3)
//   pins      - map of PIN -> rep label. For a SHARED dealership PIN, use a
//               single entry labelled "Front desk" / "Showroom". For PER-REP
//               PINs later, add one entry per salesperson; the label flows
//               through to the payload as `submittedBy` for attribution.
const TENANTS = [
  {
    id: "cs-mazda",
    name: "CS Mazda",
    accent: "#7eb8f7",
    webhook: CS_MAZDA_GHL_WEBHOOK,
    pins: {
      [CS_MAZDA_PIN]: "Showroom", // shared dealership PIN for the pilot
      // Per-rep example (leave commented for pilot):
      // "1188": "Nik",
      // "1199": "Sam",
    },
  },
  // Future dealership (illustrative — add when you sign #2):
  // {
  //   id: "metro-ford",
  //   name: "Metro Ford",
  //   accent: "#3b82f6",
  //   webhook: process.env.METRO_FORD_GHL_WEBHOOK || null,
  //   pins: { [process.env.METRO_FORD_PIN || "0000"]: "Showroom" },
  // },
];

// Resolve a submitted code to { tenant, repLabel } or null.
// Constant-ish lookup; no early-exit timing games needed at this scale.
export function resolveTenant(code) {
  const clean = String(code || "").trim();
  if (!clean) return null;
  for (const t of TENANTS) {
    if (Object.prototype.hasOwnProperty.call(t.pins, clean)) {
      return {
        tenant: {
          id: t.id,
          name: t.name,
          accent: t.accent || "#7eb8f7",
          webhook: t.webhook || null,
        },
        repLabel: t.pins[clean], // "Showroom" (shared) or a rep name (per-rep)
      };
    }
  }
  return null;
}

// Look up a tenant by id (used by the send endpoint to find the webhook).
export function getTenantById(id) {
  const t = TENANTS.find((x) => x.id === id);
  if (!t) return null;
  return { id: t.id, name: t.name, accent: t.accent || "#7eb8f7", webhook: t.webhook || null };
}
