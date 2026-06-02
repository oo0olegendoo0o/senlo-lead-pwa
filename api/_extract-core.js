// extract.js
// Core lead-extraction logic for the Senlo dealership lead tool.
// Single-pass-with-confidence: one Haiku vision call returns each field,
// the exact characters read from the image, and a per-field verified flag.
//
// This module is environment-agnostic. It is consumed by:
//   - test-local.js        (Stage 1: run against a real screenshot on your machine)
//   - api/extract.js       (Stage 2+: the Vercel serverless function)
//
// It takes a base64 image + media type and returns a structured result.
// It does NOT read env vars, touch the filesystem, or know about HTTP.

import Anthropic from "@anthropic-ai/sdk";

// ---- Model + cost knobs (single source of truth) -------------------------
export const MODEL = "claude-haiku-4-5-20251001";
export const MAX_TOKENS = 600; // structured JSON out is small; this is generous

// ---- The extraction prompt ------------------------------------------------
// This is the highest-leverage part of the whole system. Notes on the design:
//  - We force JSON-only output (no prose, no markdown fences) for clean parsing.
//  - For EACH field we ask for three things:
//        value      -> the cleaned, normalised value we actually use
//        read       -> the exact characters/text seen on the screen (for the
//                      green-check "I read this as: X" UX and digit auditing)
//        verified   -> the model's own confidence that `value` faithfully
//                      matches what is visible, char-for-char where relevant
//  - We give explicit normalisation rules so output is consistent across
//    different AutoGate layouts and lead sources.
//  - We tell it exactly how to handle a missing field (null, not a guess).
const SYSTEM_PROMPT = `You are a precise data-extraction engine for an Australian car dealership. You are shown a screenshot of a single sales lead taken from the AutoGate (Cox Automotive) customer-detail portal. Your only job is to read five fields off the image and report them as strict JSON.

Extract exactly these fields:

1. name      - The customer's name. First name alone is acceptable; include surname if clearly shown. Title case. Do not include labels like "Name:".
2. mobile    - The customer's mobile phone number. CRITICAL: return the digits EXACTLY as they appear on the screen, including any leading +61 or 0, in BOTH "value" and "read". Do NOT convert, reformat, regroup, or rearrange the digits in any way — do not change +61 to 0. Read each digit with extreme care and never transpose, add, or drop a digit. The system reformats it afterwards; your only job is to transcribe the exact digits shown.
3. email     - The customer's email address, if present. Lowercase. Must contain a single @ and a domain. If no email is visible, this is null (not all leads have one).
4. car       - CORE FIELD. The vehicle the customer enquired about. Look across the whole screenshot (heading, vehicle/stock section, subject line, comment) before concluding there is none.
               Return ONLY: YEAR MAKE MODEL. The MODEL is the short model name only (e.g. CX-3, CX-30, Corolla, Cerato, Ranger). You MUST remove everything else, including: colour and paint names (Jet Black, Snowflake White Pearl, Snow White Pearl), engine/variant badges (G20, G25, GT-Line, Ascent, XLT), body style (Wagon, Hatchback, Sedan, SUV), trim/grade (Touring, Pure, Sport, Sports), and transmission (Automatic, Manual, Sports Automatic).
               Worked examples (read -> value):
                 "2024 Snowflake White Pearl Mazda CX-30 G20 Touring Wagon Sports Automatic" -> "2024 Mazda CX-30"
                 "2021 Snow White Pearl Kia Cerato Sport Hatchback Sports Automatic" -> "2021 Kia Cerato"
                 "2025 Jet Black Mazda CX-3 G20 Pure Wagon Sports Automatic" -> "2025 Mazda CX-3"
                 "2009 Toyota Corolla Ascent" -> "2009 Toyota Corolla"
               If no year is visible, omit the year (just MAKE MODEL). Only return null if no vehicle is genuinely present anywhere on the image. The "read" field should still contain the full raw vehicle text as shown.
5. postcode  - The customer's 4-digit Australian postcode, if present. Digits only. If not visible, null.

For EVERY field return an object with three keys:
  "value"    - the cleaned, normalised value described above (or null if not present / not readable)
  "read"     - the exact raw characters you see on the screen for this field, before normalising (or null if not present). For the mobile, write the digits exactly as displayed.
  "verified" - true only if you are confident "value" faithfully and accurately reflects what is shown on the image, character-for-character for the mobile and email. false if the text is blurry, partially cut off, ambiguous, or you had to guess.

Also return a top-level "comment" string: any free-text note or message the customer left (e.g. "please message back, no call required"), or null if none. This is not validated but is passed downstream.

Rules:
- Output ONLY a single JSON object. No prose, no explanation, no markdown code fences.
- Never invent or guess a value. If you cannot read it, value is null and verified is false.
- Do not include any field other than the schema below.

Schema:
{
  "name":     { "value": string|null, "read": string|null, "verified": boolean },
  "mobile":   { "value": string|null, "read": string|null, "verified": boolean },
  "email":    { "value": string|null, "read": string|null, "verified": boolean },
  "car":      { "value": string|null, "read": string|null, "verified": boolean },
  "postcode": { "value": string|null, "read": string|null, "verified": boolean },
  "comment":  string|null
}`;

const USER_PROMPT =
  "Extract the five lead fields plus comment from this AutoGate lead screenshot. Return strict JSON only.";

// ---- Validation layer (Australian-specific, deterministic) ----------------
// Runs AFTER the model. The model gives confidence; this gives hard rules.
// The two together drive the green-check UX. Mobile is the only hard gate.

const AU_MOBILE_RE = /^04\d{2}\s?\d{3}\s?\d{3}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POSTCODE_RE = /^\d{4}$/;

// Deterministically convert any AU mobile form to "04XX XXX XXX".
// Handles: +61 4xx xxx xxx, 0061 4xx..., 61 4xx..., 04xx xxx xxx, with or
// without spaces/dashes/parens. Returns null if it isn't a valid AU mobile.
// This is done in CODE (not by the model) so digits are never transposed.
export function normaliseAuMobile(raw) {
  if (!raw) return null;
  // Keep digits only (drop +, spaces, dashes, parens, etc.)
  let d = String(raw).replace(/\D/g, "");
  // Strip international prefixes down to the national form.
  if (d.startsWith("0061")) d = d.slice(4); // 0061... -> ...
  else if (d.startsWith("61")) d = d.slice(2); // 61...   -> ...
  // At this point a mobile should be either "4xxxxxxxx" (9 digits, no leading 0)
  // or "04xxxxxxxx" (10 digits). Normalise to the leading-0 national form.
  if (d.length === 9 && d.startsWith("4")) d = "0" + d; // 4xxxxxxxx -> 04xxxxxxxx
  // Must now be exactly 10 digits starting 04.
  if (!/^04\d{8}$/.test(d)) return null;
  // Group 4-3-3.
  return d.replace(/^(\d{4})(\d{3})(\d{3})$/, "$1 $2 $3");
}

export function validate(fields) {
  const checks = {};

  // NAME: PREFERRED, not required. A missing name never blocks send.
  // It sets hasName=false so GHL opens with a generic line ("Hi, I saw you enquired").
  const name = fields.name?.value?.trim();
  const hasName = !!name && name.length >= 2 && !/^name$/i.test(name);
  checks.name = {
    ok: hasName, // "ok" here means "usable name present", not "required"
    required: false,
    value: hasName ? name : null,
    read: fields.name?.read ?? null,
    modelVerified: !!fields.name?.verified,
  };

  // MOBILE: PRIMARY contact path. The model returns digits EXACTLY as seen;
  // we convert to 04XX XXX XXX here, in code, so conversion is never guessed.
  // If absent/invalid, we fall back to email (gate is "contactable", below).
  const mobileGrouped = normaliseAuMobile(fields.mobile?.value ?? fields.mobile?.read);
  const mobileOk = AU_MOBILE_RE.test(mobileGrouped || "");
  checks.mobile = {
    ok: mobileOk,
    value: mobileGrouped,
    read: fields.mobile?.read ?? null,
    modelVerified: !!fields.mobile?.verified,
    primaryContact: true,
  };

  // EMAIL: BONUS, but doubles as the FALLBACK contact path when no mobile.
  // Blank is fine; malformed is flagged. A valid email makes a no-mobile lead
  // still actionable (email outreach instead of SMS).
  const email = fields.email?.value?.trim()?.toLowerCase() || null;
  const emailValid = email !== null && EMAIL_RE.test(email);
  checks.email = {
    ok: email === null || EMAIL_RE.test(email), // present-and-valid OR absent
    valid: emailValid, // strictly: a usable email is present
    present: email !== null,
    value: email,
    read: fields.email?.read ?? null,
    modelVerified: !!fields.email?.verified,
    fallbackContact: true,
  };

  // CAR: CORE field. A lead almost always enquired on a specific vehicle, and
  // the booking bot needs it to know what to book. We flag it prominently if
  // missing (hasCar=false => GHL opens with "which vehicle were you after?"),
  // but it does NOT block send — a contactable lead with no car is still a real
  // person we message; losing them to a disabled button would be worse.
  const car = fields.car?.value?.trim() || null;
  const hasCar = !!car && car.length >= 3;
  checks.car = {
    ok: hasCar,
    core: true, // important, prominently surfaced — but not a send gate
    value: hasCar ? car : null,
    read: fields.car?.read ?? null,
    modelVerified: !!fields.car?.verified,
  };

  // POSTCODE: BONUS. 4 digits if present; only used for distance-to-dealership.
  const postcode = fields.postcode?.value?.trim() || null;
  checks.postcode = {
    ok: postcode === null || POSTCODE_RE.test(postcode),
    present: postcode !== null,
    value: postcode,
    read: fields.postcode?.read ?? null,
    modelVerified: !!fields.postcode?.verified,
  };

  // ---- The gate: a lead is sendable if it is CONTACTABLE ----
  // Contactable = a valid mobile OR a valid email. Mobile is preferred; if only
  // email exists, we route to email outreach. No contact at all => cannot send.
  const contactable = mobileOk || emailValid;

  // Preferred channel for GHL: SMS if mobile, else email.
  const channel = mobileOk ? "sms" : emailValid ? "email" : null;

  // Routing flags passed downstream so GHL knows how to open the conversation.
  const flags = {
    hasName, // false => GHL uses generic opener ("Hi, I saw you enquired")
    hasCar, // false => bot must ask which vehicle
    channel, // "sms" | "email" | null
    emailOnly: !mobileOk && emailValid, // no phone; exhaust email avenue
    prefersText: /no call|text|message back|don'?t call|sms/i.test(fields.comment || ""),
    hasComment: !!fields.comment,
  };

  // allGreen = everything that is present is valid AND we have a contact method.
  // (Optional-but-absent fields don't break the tick; malformed ones do.)
  const allGreen =
    contactable &&
    checks.email.ok && // valid-if-present
    checks.postcode.ok; // valid-if-present

  return {
    checks,
    flags,
    comment: fields.comment ?? null,
    canSend: contactable, // gate: at least one usable contact method
    allGreen, // drives the green tick
  };
}

// ---- The single Haiku call ------------------------------------------------
export async function extractLead({ apiKey, base64, mediaType }) {
  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64 },
          },
          { type: "text", text: USER_PROMPT },
        ],
      },
    ],
  });

  // Pull the text block, strip any stray fences, parse.
  const textBlock = message.content.find((b) => b.type === "text");
  const raw = (textBlock?.text || "").replace(/```json|```/g, "").trim();

  let fields;
  try {
    fields = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Model did not return valid JSON. Raw output:\n${raw}\n\nParse error: ${e.message}`
    );
  }

  const validation = validate(fields);

  return {
    fields, // raw model output (value/read/verified per field)
    validation, // deterministic checks + canSend + allGreen
    usage: message.usage, // input/output tokens -> cost tracking
    model: MODEL,
  };
}
