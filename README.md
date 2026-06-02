# Senlo Lead PWA — Stage 2

The rep-facing tool. A salesperson opens it on their phone, enters their
dealership code, screenshots the AutoGate lead, checks the auto-extracted
fields, and taps Send. Built to match the Senlo site's design.

**This is a separate project from `senlo-site`.** It deploys to its own Vercel
project on a subdomain (`leads.senlo.com.au`). Your live marketing site is never
touched.

## What it does (the rep flow)
1. **Code screen** — rep enters a 4-digit dealership PIN. The PIN is validated
   server-side and maps to that dealership's pipeline. The browser never sees
   the PIN list or any webhook.
2. **Capture** — tap to upload an AutoGate screenshot. Image is compressed in
   the browser before upload.
3. **Confirm** — fields auto-fill with a green/red check per field. Mobile is
   normalised to `04XX XXX XXX`. Tap any field to edit. A valid mobile OR email
   is required to send.
4. **Send** — (pilot / option B) shows the exact payload that will flow to GHL.
   Stage 3 flips on the real webhook POST.

## Architecture
```
public/index.html          the PWA (Senlo-styled, all UI + client logic)
public/manifest.webmanifest install-to-home-screen
public/icon.svg            app icon
api/auth.js                POST {code} -> validates PIN, returns signed token
api/extract.js             POST {token,image} -> Haiku extraction (holds API key)
api/send.js                POST {token,fields} -> validates + builds payload (option B)
api/_extract-core.js       the proven extraction + validation logic (Stage 1)
api/_tenants.js            SERVER-ONLY tenant + PIN config
vercel.json                static public/ + serverless api/
```

The Anthropic API key and all PINs/webhooks live ONLY in Vercel environment
variables — never in the repo, never in the browser.

## Deploy (one-time)

### 1. Put it on GitHub
Create a new repo (e.g. `senlo-lead-pwa`) — separate from `senlo-site` — and
push these files.

### 2. Import to Vercel
- vercel.com → Add New → Project → import the `senlo-lead-pwa` repo.
- Framework preset: **Other** (it's static + serverless functions, no build).
- Deploy. You'll get a `*.vercel.app` URL to test first.

### 3. Set environment variables (Vercel → Project → Settings → Environment Variables)
| Name | Value | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | your `sk-ant-...` key | the business key with the spend cap |
| `TOKEN_SECRET` | any long random string | signs session tokens; make it long |
| `CS_MAZDA_PIN` | e.g. `4729` | the dealership code reps will type |
| `CS_MAZDA_GHL_WEBHOOK` | leave unset for now | set in Stage 3 |

Redeploy after adding env vars so they take effect.

### 4. Add the subdomain
- Vercel → Project → Settings → Domains → add `leads.senlo.com.au`.
- Because senlo's nameservers already point to Vercel, Vercel creates the DNS
  record automatically. Nothing to do at Porkbun.

### 5. Install on a rep's phone
- Open `leads.senlo.com.au` in Safari/Chrome on the phone.
- Share → Add to Home Screen. It launches full-screen like an app.

## Local preview (optional)
The functions are Vercel-style handlers. To run locally:
```bash
npm install
npm i -g vercel
vercel dev
```
Then set the same env vars locally (or a `.env.local`). Without `vercel dev`,
opening index.html directly won't work because the `/api/*` calls need the
serverless runtime.

## Security status (honest)
- Real: PIN validated server-side; tenant list + webhooks never sent to browser;
  session token is HMAC-signed (tamper- and expiry-checked); server re-validates
  every send (client is never trusted).
- Deferred (Stage 4 / pre-scale hardening): PIN attempt rate-limiting, lockout,
  per-rep PINs for attribution. Fine for a single-dealership pilot; do before
  multiple real dealerships depend on it.

## Stage 3 (next)
Wire GHL: set `CS_MAZDA_GHL_WEBHOOK`, uncomment the POST in `api/send.js`, build
the GHL workflow (inbound webhook -> Conversation AI -> calendar -> rep notify).
