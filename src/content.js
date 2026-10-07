(() => {
  const SKIP_CATEGORIES = { sponsor: true, selfpromo: true, interaction: true, intro: false, outro: false };
  const COLORS = { sponsor: "#00d400", selfpromo: "#ffff00", intro: "#00ffff", outro: "#0202ed", interaction: "#cc00ff" };

  let captionUrl = null;
  const state = { videoId: null, segments: [], threshold: 0.7, enabled: true };

  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.source === "skipper" && e.data.type === "caption-url") {
      captionUrl = e.data.url;
    }
  });

  const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
  const video = () => document.querySelector("video.html5-main-video");
  const videoIdNow = () => new URLSearchParams(location.search).get("v");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function loadSettings() {
    const s = await chrome.storage.local.get(["threshold", "enabled"]);
    state.threshold = typeof s.threshold === "number" ? s.threshold : 0.7;
    state.enabled = s.enabled !== false;
  }

  async function fetchCues() {
    for (let i = 0; i < 16 && !captionUrl; i++) {
      if (i === 6) window.postMessage({ source: "skipper", type: "enable-captions" }, "*");
      await sleep(500);
    }
    if (!captionUrl) return [];
    const u = new URL(captionUrl);
    u.searchParams.set("fmt", "json3");
    const body = await (await fetch(u.toString())).text();
    if (!body) return [];
    return (JSON.parse(body).events || [])
      .filter((ev) => ev.segs)
      .map((ev) => ({
        start: ev.tStartMs / 1000,
        end: (ev.tStartMs + (ev.dDurationMs || 0)) / 1000,
        text: ev.segs.map((s) => s.utf8).join("").replace(/\s+/g, " ").trim()
      }))
      .filter((c) => c.text);
  }

  // Slices are tinted by confidence: a borderline guess is a ghost, a sure one is solid.
  function paint() {
    document.querySelectorAll(".skipper-slice").forEach((n) => n.remove());
    const bar = document.querySelector(".ytp-progress-bar");
    const v = video();
    if (!bar || !v || !isFinite(v.duration)) return;
    for (const seg of state.segments) {
      const el = document.createElement("div");
      el.className = "skipper-slice";
      el.style.left = (seg.start / v.duration) * 100 + "%";
      el.style.width = ((seg.end - seg.start) / v.duration) * 100 + "%";
      el.style.background = COLORS[seg.category] || "#fff";
      el.style.opacity = String(0.3 + 0.7 * seg.p);
      el.title = `${seg.category} (${Math.round(seg.p * 100)}%)`;
      bar.appendChild(el);
    }
  }

  function toast(text, undo) {
    document.querySelectorAll(".skipper-toast").forEach((n) => n.remove());
    const t = document.createElement("div");
    t.className = "skipper-toast";
    t.textContent = text + " ";
    if (undo) {
      const b = document.createElement("button");
      b.textContent = "Undo";
      b.onclick = () => { undo(); t.remove(); };
      t.appendChild(b);
    }
    (document.getElementById("movie_player") || document.body).appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

  let muteUntil = 0;
  function onTime() {
    const v = video();
    if (!v || !state.enabled || v.currentTime < muteUntil) return;
    const now = v.currentTime;
    const seg = state.segments.find(
      (s) => now >= s.start && now < s.end - 0.5 && s.p >= state.threshold && SKIP_CATEGORIES[s.category]
    );
    if (!seg) return;
    const from = now;
    v.currentTime = seg.end;
    toast(`Skipped ${seg.category} (${Math.round(seg.end - from)}s)`, () => {
      muteUntil = seg.end;
      v.currentTime = from;
    });
  }

  async function analyze() {
    const id = videoIdNow();
    if (!id || id === state.videoId) return;
    state.videoId = id;
    state.segments = [];
    muteUntil = 0;
    captionUrl = null;
    paint();
    await loadSettings();

    const cacheKey = "seg:" + id;
    const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
    if (cached) { state.segments = cached; return paint(); }

    let r = await send({ type: "labels", videoId: id });
    if (state.videoId !== id) return;
    if (r && r.ok && r.segments.length) {
      state.segments = r.segments;
    } else {
      const cues = await fetchCues();
      if (state.videoId !== id || !cues.length) return;
      const title = document.title.replace(/ - YouTube$/, "");
      const channel = (document.querySelector("ytd-channel-name a") || {}).textContent || "";
      r = await send({ type: "analyze", videoId: id, title, channel, cues });
      if (state.videoId !== id) return;
      if (!r || !r.ok) return toast("Skipper: " + ((r && r.error) || "no answer"));
      state.segments = r.segments;
      if (r.stats) chrome.storage.local.set({ lastRun: Object.assign({ at: Date.now(), segments: r.segments.length }, r.stats) });
    }
    chrome.storage.local.set({ [cacheKey]: state.segments });
    paint();
  }

  document.addEventListener("yt-navigate-finish", analyze);
  document.addEventListener("timeupdate", onTime, true);
  chrome.storage.onChanged.addListener(loadSettings);
  window.addEventListener("resize", paint);
  analyze();
})();
