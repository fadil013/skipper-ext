const MODEL = "claude-haiku-4-5-20251001";
const CATEGORIES = ["sponsor", "selfpromo", "intro", "outro", "interaction"];
const WINDOW_SECONDS = 30;
const MAX_WINDOW_SECONDS = 45;
// Cheap evidence that a window is an ad read: a URL, a coupon-code shape, or "use my link".
const AD_SIGNS = /(https?:\/\/|\b[a-z0-9-]+\.(com|co|io|tv|app)\/\w+|\b(code|coupon|promo)\s+[A-Z0-9]{3,}\b|use (my|the) (link|code)|link in the description|sponsored by)/i;

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const job = msg.type === "labels" ? fromCrowd(msg.videoId)
    : msg.type === "analyze" ? fromModel(msg)
    : null;
  if (!job) return false;
  job.then(
    (result) => reply(Object.assign({ ok: true }, result)),
    (err) => reply({ ok: false, error: String(err.message || err) })
  );
  return true;
});

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Crowd labels, fetched by hash prefix so the video id itself never leaves the browser.
async function fromCrowd(videoId) {
  const prefix = (await sha256Hex(videoId)).slice(0, 4);
  const cats = encodeURIComponent(JSON.stringify(CATEGORIES));
  const res = await fetch(`https://sponsor.ajay.app/api/skipSegments/${prefix}?categories=${cats}&actionType=skip`);
  if (res.status === 404) return { segments: [] };
  if (!res.ok) throw new Error(`crowd lookup failed (${res.status})`);
  const mine = (await res.json()).find((v) => v.videoID === videoId);
  if (!mine) return { segments: [] };
  return {
    segments: mine.segments.map((s) => ({ start: s.segment[0], end: s.segment[1], category: s.category, p: 1, source: "crowd" }))
  };
}

// Cut caption cues into ~30s windows that end on a sentence boundary, capped at 45s.
function makeWindows(cues) {
  const windows = [];
  let cur = null;
  for (const cue of cues) {
    if (!cur) cur = { start: cue.start, end: cue.end, text: "" };
    cur.text += (cur.text ? " " : "") + cue.text;
    cur.end = cue.end;
    const len = cur.end - cur.start;
    const sentenceEnd = /[.!?]["')\]]?\s*$/.test(cue.text);
    if ((len >= WINDOW_SECONDS && sentenceEnd) || len >= MAX_WINDOW_SECONDS) {
      windows.push(cur);
      cur = null;
    }
  }
  if (cur) windows.push(cur);
  return windows;
}

function stamp(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function fromModel({ title, channel, cues }) {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) throw new Error("no API key set (open the Skipper popup)");
  const windows = makeWindows(cues);
  if (!windows.length) return { segments: [] };

  const transcript = windows
    .map((w, i) => `[${i}]${AD_SIGNS.test(w.text) ? " (has link/code)" : ""} (${stamp(w.start)}-${stamp(w.end)}) ${w.text}`)
    .join("\n");
  const prompt =
    `Video: "${title}" by ${channel}\n\n` +
    "Below is a transcript split into numbered windows. For EVERY window, say which one it is: " +
    "sponsor (paid ad read), selfpromo (creator plugging own merch/channel/course), intro (generic intro), " +
    "outro (end cards), interaction (like/subscribe begging), or content (real content).\n" +
    'Reply with ONLY a JSON array, one object per window: {"i":<index>,"c":"<category>","p":<probability 0-1 that it is NOT content>}.\n\n' +
    transcript;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, messages: [{ role: "user", content: prompt }] })
  });
  if (!res.ok) throw new Error(`model call failed (${res.status})`);
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("");
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("model returned no JSON");
  const rows = JSON.parse(match[0]);

  const segments = rows
    .filter((r) => windows[r.i] && r.c !== "content")
    .map((r) => ({
      start: windows[r.i].start,
      end: windows[r.i].end,
      category: r.c,
      p: Math.max(0, Math.min(1, +r.p || 0)),
      source: "model"
    }));
  const usage = data.usage || {};
  return { segments, stats: { windows: windows.length, inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0 } };
}
