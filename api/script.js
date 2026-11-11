// POST /api/script  body: {idea, niche, lang} -> timed reel script with 2 hooks.
import { gemini, parseJson, limited, userKey, fail, httpError } from "./_lib.js";

const RULES = `RETENTION RULES (non-negotiable):
- Face-on-camera reel, 40-45s, 105-125 spoken words total (about 2.7 words/sec).
- 0-3s HOOK 1: start mid-action. No hello, no intro. Max 12 words. Speak to ONE person. It must be truthful to the payoff (no clickbait mismatch).
- 3-9s STAKES: why staying is worth it; plant an open loop.
- 9-13s HOOK 2 (re-hook at the usual drop-off point): pattern interrupt + a NEW curiosity gap or contradiction. Must feel like a second opening.
- 13-30s VALUE: 3 short steps, one idea each; a mini-cliffhanger around 22-26s.
- 30-40s PAYOFF: deliver exactly what was promised, concrete and specific.
- 40-45s CTA + loop: one line CTA; last line connects back to hook 1 so it rewatches seamlessly.
- Sentences max 10 words. Change visual (cut/zoom/text/b-roll) every 2-3s. Casual spoken language, how a friend talks.
- Never invent tools, features or numbers not given in the idea/evidence.`;

const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;
const spoken = (d) => d.script.map((b) => b.say).join(" ");
function check(d) {
  const beats = d.script.map((b) => String(b.beat).toUpperCase());
  if (!beats.includes("HOOK 1") || !beats.includes("HOOK 2")) return "must contain both a HOOK 1 beat and a HOOK 2 beat";
  const n = words(spoken(d));
  if (n < 95 || n > 135) return `voiceover is ${n} words, must be 105-125`;
  if (words(d.script[0].say) > 14) return "hook 1 is longer than 12 words, shorten it";
  return "";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") throw httpError(405, "POST only");
    const { idea, niche = "", lang = "Hinglish (Roman Hindi + English), casual" } = req.body || {};
    if (!idea || typeof idea !== "object" || !idea.title) throw httpError(400, "Idea missing.");
    const own = userKey(req);
    if (!own && limited(req, "script", 8)) throw httpError(429, "Is ghante ke free uses khatam. Thodi der baad aao, ya neeche settings me apni free Gemini key daalo.");
    const key = own || process.env.GEMINI_API_KEY;
    const slim = JSON.stringify(idea).slice(0, 3000);

    const make = async (fix = "") => parseJson(await gemini(`You write viral short-form scripts. Niche: ${String(niche).slice(0, 80)}.
Language: ${String(lang).slice(0, 80)}.
IDEA: ${slim}
${RULES}
Steps: (1) write 5 hook candidates using different patterns (curiosity gap, bold claim, pain call-out, result-first, contradiction), score each 1-10 for stop-the-scroll power, pick the best as HOOK 1. (2) write the full timed script with that hook and a separate HOOK 2.
${fix ? "FIX FROM LAST ATTEMPT: " + fix : ""}
Return ONLY JSON: {"hook_candidates":[{"pattern":str,"line":str,"score":int}],"best_hook":str,
"script":[{"t":"0-3s","beat":"HOOK 1","say":str,"on_screen":str,"visual":str},{"t":"3-9s","beat":"STAKES",...},{"t":"9-13s","beat":"HOOK 2",...},{"t":"13-30s","beat":"VALUE",...},{"t":"30-40s","beat":"PAYOFF",...},{"t":"40-45s","beat":"CTA + LOOP",...}],
"caption":str (short, with 5 hashtags),"retention_notes":str (2 lines)}`, key));

    let d = await make();
    let err = check(d);
    if (err) { d = await make(err); err = check(d); }
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).json({ ...d, words: words(spoken(d)), warning: err });
  } catch (e) { fail(res, e); }
}
