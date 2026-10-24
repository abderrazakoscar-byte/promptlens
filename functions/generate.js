// Netlify serverless function: image -> prompt, powered by the Google Gemini API.
// Requires a logged-in user (Supabase) and uses one credit per prompt.
// Environment variables: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional: GEMINI_MODEL (default below).

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_BASE64_CHARS = 5_500_000; // ~4MB of image data
const MAX_FETCH_BYTES = 4 * 1024 * 1024;

const JSON_FIELDS =
  '{"subject": "", "action_or_pose": "", "setting": "", "style": "", "lighting": "", "composition": "", "colors": "", "mood": "", "extra_details": ""}';

const MODES = {
  general:
    "Write one rich, detailed paragraph that describes this image so an AI image generator could recreate it: main subject, action or pose, setting, artistic style, colors, lighting, composition, mood.",
  structured:
    "Break the image into editable parameters. Return ONLY valid JSON, no markdown, with exactly these string keys: " +
    JSON_FIELDS +
    ". Each value is a short, concrete phrase or two.",
  graphic:
    "Describe this as a graphic design so a designer or an AI generator could recreate the artwork: layout, focal element, illustration or lettering style, typography feel (without naming fonts you are unsure of), shapes, icons, color palette (name each main color), texture, background, and overall visual style. Describe the design itself only, not any product it might be printed on.",
  json:
    "Return ONLY valid JSON, no markdown, describing the image in detail with keys: subject, action_or_pose, setting, background, style, medium, colors (array), lighting, camera_or_perspective, composition, mood, details (array), text_in_image.",
  flux:
    "Write a Flux-style prompt: a natural-language, flowing description of the scene (subject first, then setting, style, lighting, camera or composition details). No keyword weights, no parameters.",
  midjourney:
    "Write a Midjourney-style prompt: comma-separated descriptive phrases (subject, setting, style, lighting, color, mood), then end with suitable parameters such as --ar W:H matching the image shape and --v 7. Output the single prompt line only.",
  sd:
    "Write a Stable Diffusion prompt: comma-separated tags ordered by importance (subject, style, details, lighting, quality tags), then a new line starting with 'Negative prompt:' followed by sensible negative tags.",
};

const SYSTEM =
  "You are an expert at analysing images and writing prompts for AI image generators. " +
  "Output only the requested prompt, with no preface, no explanation and no closing remarks. " +
  "Do not identify real people by name; describe them by visible traits only. " +
  "If the image contains explicit sexual content, nudity, or sexualised minors, output exactly BLOCKED_NSFW and nothing else.";

const reply = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/* ---------- Supabase helpers (login check + credits) ---------- */
async function getUser(authHeader) {
  const token = (authHeader || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch {
    return null;
  }
}

async function rpc(name, args) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/* ---------- image URL fetching (with basic safety) ---------- */
function isPrivateHost(host) {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^\[?(::1|fc|fd|fe80)/.test(h)) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

async function fetchImageAsBase64(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw { status: 400, message: "Invalid image URL." };
  }
  if (!["http:", "https:"].includes(url.protocol) || isPrivateHost(url.hostname))
    throw { status: 400, message: "This image URL isn't allowed." };

  const res = await fetch(url.href, { redirect: "error" });
  if (!res.ok) throw { status: 400, message: "Couldn't download that image." };
  const type = (res.headers.get("content-type") || "").split(";")[0].trim();
  if (!ALLOWED_TYPES.includes(type))
    throw { status: 400, message: "The link must point to a PNG, JPG, WEBP or GIF image." };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_FETCH_BYTES) throw { status: 413, message: "Image is too large (max about 4MB)." };
  return { media_type: type, data: buf.toString("base64") };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return reply(405, { error: "POST only" });
  if (!process.env.GEMINI_API_KEY)
    return reply(500, { error: "Server is missing GEMINI_API_KEY." });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    return reply(500, { error: "Server is missing Supabase settings." });

  // 1) Must be logged in
  const user = await getUser(event.headers.authorization || event.headers.Authorization);
  if (!user) return reply(401, { error: "Please log in to generate prompts." });

  let input;
  try {
    input = JSON.parse(event.body || "{}");
  } catch {
    return reply(400, { error: "Invalid JSON body." });
  }

  const mode = MODES[input.mode] ? input.mode : "general";
  const language = String(input.language || "English").slice(0, 40);

  // 2) Read the image (invalid requests don't use a credit)
  let image;
  try {
    if (input.imageUrl) {
      image = await fetchImageAsBase64(input.imageUrl);
    } else if (input.image && input.image.data) {
      const { media_type, data } = input.image;
      if (!ALLOWED_TYPES.includes(media_type))
        return reply(400, { error: "Use a PNG, JPG, WEBP or GIF image." });
      if (typeof data !== "string" || data.length > MAX_BASE64_CHARS)
        return reply(413, { error: "Image is too large (max about 4MB)." });
      image = { media_type, data };
    } else {
      return reply(400, { error: "No image provided." });
    }
  } catch (e) {
    return reply(e.status || 400, { error: e.message || "Couldn't read the image." });
  }

  // 3) Use one credit
  const credit = await rpc("consume_credit", { uid: user.id });
  if (!credit) return reply(500, { error: "Couldn't check your credits. Try again." });
  if (!credit.ok)
    return reply(402, {
      error:
        credit.plan === "pro"
          ? "You've used all your prompts for this month."
          : "You've used your free prompts for today. Come back tomorrow or upgrade.",
      credits: credit,
    });
  const refund = () => rpc("refund_credit", { uid: user.id });

  const instruction =
    MODES[mode] +
    (language.toLowerCase() === "english"
      ? ""
      : ` Write the prompt text in ${language} (keep any parameters like --ar or --v as they are).`);

  // 4) Ask Gemini (credit is given back if the AI side fails)
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType: image.media_type, data: image.data } },
                { text: instruction },
              ],
            },
          ],
          generationConfig: { maxOutputTokens: 1200, temperature: 0.4 },
        }),
      }
    );
    const out = await res.json();
    if (!res.ok) {
      await refund();
      return reply(502, { error: out?.error?.message || "The AI service returned an error." });
    }

    if (out.promptFeedback?.blockReason)
      return reply(422, { error: "This image can't be processed (blocked by the safety filter)." });

    const cand = out.candidates?.[0];
    let text = (cand?.content?.parts || []).map((p) => p.text || "").join("").trim();
    if (!text) {
      if (cand?.finishReason === "SAFETY")
        return reply(422, { error: "This image can't be processed (blocked by the safety filter)." });
      await refund();
      return reply(422, { error: "No prompt was returned. Try again." });
    }
    if (text.includes("BLOCKED_NSFW"))
      return reply(422, { error: "This image can't be processed (adult content isn't allowed)." });

    if (mode === "structured" || mode === "json") {
      text = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
      try {
        return reply(200, { mode, data: JSON.parse(text), credits: credit });
      } catch {
        return reply(200, { mode: "general", text, credits: credit });
      }
    }
    return reply(200, { mode, text, credits: credit });
  } catch (err) {
    await refund();
    return reply(500, { error: "Request failed: " + err.message });
  }
};
