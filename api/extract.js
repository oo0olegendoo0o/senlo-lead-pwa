// api/extract.js
// POST { token, image (base64), mediaType } -> runs the proven Haiku extraction
// and returns { fields, validation, usage }. The Anthropic API key lives ONLY
// here, as a Vercel env var — never in the browser.

import { extractLead } from "./_extract-core.js";
import { verifyToken } from "./auth.js";

// Vercel: allow a larger body for base64 images.
export const config = { api: { bodyParser: { sizeLimit: "8mb" } } };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { token, image, mediaType } = req.body || {};

  // Session check — must have passed a valid PIN.
  const session = verifyToken(token);
  if (!session) {
    res.status(401).json({ ok: false, error: "Session expired — enter your code again" });
    return;
  }

  if (!image || !mediaType) {
    res.status(400).json({ ok: false, error: "Missing image" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ ok: false, error: "Server not configured (no API key)" });
    return;
  }

  try {
    const result = await extractLead({ apiKey, base64: image, mediaType });
    res.status(200).json({
      ok: true,
      fields: result.fields,
      validation: result.validation,
      usage: result.usage,
      tenant: session.tid,
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: "Extraction failed", detail: String(err.message || err) });
  }
}
