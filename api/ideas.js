// GET /api/ideas?niche=...&lang=...  -> 10 ranked ideas from YouTube + news signals.
import { gemini, parseJson, limited, userKey, fail, httpError } from "./_lib.js";

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">");

async function news(niche) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(niche)}+when:2d&hl=en-IN&gl=IN&ceid=IN:en`;
    const x = await (await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } })).text();
    return [...x.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g)]
      .slice(0, 12).map((m) => decode(m[1].trim()));
  } catch { return []; }
}

async function youtube(niche, key) {
  if (!key) return [];
  const yr = new Date().getFullYear();
  const queries = [niche, `${niche} tips`, `${niche} mistakes`, `${niche} ${yr}`];
  const after = new Date(Date.now() - 7 * 864e5).toISOString();
  const found = new Set();
  const api = (path, params) => fetch(`https://www.googleapis.com/youtube/v3/${path}?` +
    new URLSearchParams({ ...params, key })).then((r) => r.json());
  await Promise.all(queries.map(async (q) => {
    try {
      const d = await api("search", { part: "snippet", q, type: "video", order: "viewCount",
        publishedAfter: after, maxResults: "8" });
      (d.items || []).forEach((i) => found.add(i.id.videoId));
    } catch {}
  }));
  if (!found.size) return [];
  const vids = (await api("videos", { part: "snippet,statistics", id: [...found].join(",") })).items || [];
  const chIds = [...new Set(vids.map((v) => v.snippet.channelId))];
  const subs = {};
  for (const c of (await api("channels", { part: "statistics", id: chIds.join(",") })).items || [])
    subs[c.id] = Number(c.statistics.subscriberCount || 0);
  const now = Date.now();
  const out = vids.map((v) => {
    const views = Number(v.statistics.viewCount || 0);
    const days = Math.max((now - Date.parse(v.snippet.publishedAt)) / 864e5, 0.05);
    const s = subs[v.snippet.channelId] || 0;
    return { title: v.snippet.title, channel: v.snippet.channelTitle, views,
      age_days: +days.toFixed(1), views_per_day: Math.round(views / days),
      outlier_x: +(views / Math.max(s, 1000)).toFixed(1), url: `https://youtu.be/${v.id}` };
  });
  const speed = [...out].sort((a, b) => b.views_per_day - a.views_per_day).slice(0, 14);
  const outl = [...out].sort((a, b) => b.outlier_x - a.outlier_x).slice(0, 8);
  return [...new Map([...speed, ...outl].map((v) => [v.url, v])).values()];
}

export default async function handler(req, res) {
  try {
    const niche = String(req.query.niche || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80);
    const lang = String(req.query.lang || "Hinglish (Roman Hindi + English), casual").slice(0, 80);
    if (niche.length < 2) throw httpError(400, "Niche likho (e.g. graphic design, fitness, cricket).");
    const own = userKey(req);
    if (!own && limited(req, "ideas", 4)) throw httpError(429, "Is ghante ke free uses khatam. Thodi der baad aao, ya neeche settings me apni free Gemini key daalo.");
    const key = own || process.env.GEMINI_API_KEY;

    const [yt, headlines] = await Promise.all([youtube(niche, process.env.YOUTUBE_API_KEY), news(niche)]);
    if (!yt.length && !headlines.length) throw httpError(502, "Abhi koi trending data nahi mila. Niche badal ke try karo.");

    const prompt = `You are a viral short-form content strategist. Today: ${new Date().toDateString()}.
Niche: ${niche}. Platforms: Instagram Reels / YouTube Shorts (explainer style). Write hooks/titles in: ${lang}.
SIGNALS (real data): YOUTUBE last 7 days (views_per_day = speed, outlier_x = views vs channel size, high = the idea itself is strong):
${JSON.stringify(yt)}
NEWS HEADLINES: ${JSON.stringify(headlines)}
Ignore irrelevant signals. Return ONLY a JSON list of exactly 10 objects, best first:
{"title": str, "hook": str (spoken in first 3s), "format": "Reel/Short 30-45s", "angle": str,
 "outline": [3 short beats], "evidence": str (name the specific video/headline and its numbers),
 "viral_reason": str (1-2 sentences, the mechanism: curiosity gap, relatable pain, timely trend, proven outlier, share trigger),
 "hashtags": [5 strings], "difficulty": "easy|medium|hard", "score": int 1-10}
Rules: do not invent numbers/tools not in the data; adapt proven angles instead of copying; mix quick wins and bigger bets.`;
    const ideas = parseJson(await gemini(prompt, key));
    if (!own) res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=3600");
    else res.setHeader("Cache-Control", "private, no-store");
    res.status(200).json({ niche, ideas, refs: yt.slice(0, 8) });
  } catch (e) { fail(res, e); }
}
