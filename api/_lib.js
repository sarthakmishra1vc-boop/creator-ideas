// Shared helpers: Gemini call with model fallback/retry, JSON parsing, best-effort rate limit.
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
export const MODELS = (process.env.GEMINI_MODELS || "gemini-3.6-flash,gemini-3.5-flash")
  .split(",").map((s) => s.trim()).filter(Boolean);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const httpError = (status, message) => Object.assign(new Error(message), { status });

export async function gemini(prompt, key, json = true) {
  if (!key) throw httpError(500, "Server pe GEMINI_API_KEY set nahi hai.");
  const dead = new Set();
  let last = httpError(502, "Gemini se jawab nahi aaya.");
  for (let round = 0; round < 3; round++) {
    for (const model of MODELS) {
      if (dead.has(model)) continue;
      const r = await fetch(`${BASE}/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: json ? { responseMimeType: "application/json" } : {},
        }),
      });
      if (r.ok) {
        const d = await r.json();
        const t = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
        if (t) return t;
        continue;
      }
      last = httpError(r.status, (await r.text()).slice(0, 200));
      if (r.status === 404) dead.add(model);
      if (r.status === 400 || r.status === 403) throw httpError(400, "Gemini key galat hai ya allowed nahi hai.");
    }
    if (round < 2) await sleep(1500 * (round + 1));
  }
  throw last;
}

export function parseJson(text) {
  const a = text.search(/[\[{]/);
  const open = text[a];
  const b = text.lastIndexOf(open === "[" ? "]" : "}");
  return JSON.parse(text.slice(a, b + 1));
}

// Best-effort limiter (memory is per serverless instance; use Upstash/Vercel KV for a strict one).
const hits = new Map();
export function limited(req, name, max, windowMs = 3600e3) {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  const k = `${name}:${ip}`, now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(k, arr); return true; }
  arr.push(now); hits.set(k, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}

// Optional key a visitor can supply for unlimited use (sent per request, never stored on server).
export function userKey(req) {
  const k = String(req.headers["x-user-gemini-key"] || "");
  return /^[\w-]{20,80}$/.test(k) ? k : "";
}

export function fail(res, e) {
  const s = e.status || 500;
  const msg = s === 429 && !String(e.message).startsWith("Is ghante")
    ? "Gemini ka limit lag gaya. Thodi der baad try karo, ya neeche settings me apni free Gemini key daalo."
    : s === 503 ? "Gemini abhi busy hai. 1 minute baad dobara try karo." : e.message || "Kuch gadbad hui.";
  res.status(s >= 400 && s < 600 ? s : 500).json({ error: msg });
}
