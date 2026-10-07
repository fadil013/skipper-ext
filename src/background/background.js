// Service worker. The only place that sees the API key, talks to SponsorBlock and the model,
// and owns the result cache. Content scripts get segments and status codes, never secrets.
importScripts('../shared/config.js', '../shared/validation.js', 'sponsorblock.js', 'classifier.js');

(function () {
  'use strict';
  const S = self.Skipper;
  const { CACHE_PREFIX, LIMITS, MODEL } = S;

  // Keep the API key and cache out of reach of content scripts (and therefore the page).
  try { chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }); } catch (e) { /* older Chrome */ }

  const controllers = new Map(); // tab id -> AbortController of its in-flight request

  const cacheKey = (videoId) => CACHE_PREFIX + videoId;

  async function readCache(videoId) {
    const entry = (await chrome.storage.local.get(cacheKey(videoId)))[cacheKey(videoId)];
    return S.isCacheFresh(entry, videoId, Date.now()) ? entry : null;
  }

  function writeCache(videoId, source, segments, model) {
    const entry = S.makeCacheEntry({ videoId, source, model, segments, now: Date.now() });
    return chrome.storage.local.set({ [cacheKey(videoId)]: entry });
  }

  /** Drops expired, malformed and legacy entries, then the oldest beyond the size cap. */
  async function pruneCache() {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    const keep = [];
    const drop = [];
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith('seg:')) drop.push(key);
      else if (key.startsWith(CACHE_PREFIX)) {
        if (S.isCacheFresh(value, key.slice(CACHE_PREFIX.length), now)) keep.push([key, value.createdAt]);
        else drop.push(key);
      }
    }
    keep.sort((a, b) => b[1] - a[1]);
    for (const [key] of keep.slice(LIMITS.maxCacheEntries)) drop.push(key);
    if (drop.length) await chrome.storage.local.remove(drop);
  }

  async function getSettings() {
    const { settings } = await chrome.storage.sync.get('settings');
    return S.sanitizeSettings(settings);
  }

  const withIds = (segments) => segments.map((s, i) => Object.assign({}, s, { id: i }));

  function abortFor(tabId) {
    const previous = controllers.get(tabId);
    if (previous) previous.abort();
    const controller = new AbortController();
    controllers.set(tabId, controller);
    return controller;
  }

  async function lookup(videoId, tabId) {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    const hasKey = typeof apiKey === 'string' && apiKey.length > 0;
    const cached = await readCache(videoId);
    const reply = (entry, fromCache) => ({
      ok: true, hasKey, cached: fromCache, source: entry.source, segments: withIds(entry.segments)
    });

    if (cached && cached.source === 'sponsorblock') return reply(cached, true);

    const controller = abortFor(tabId);
    let crowd = [];
    try {
      crowd = await S.fetchSegments(videoId, controller.signal);
    } catch (e) {
      if (e.name === 'AbortError') return { ok: false, code: 'ABORTED' };
    }
    if (S.hasSponsor(crowd)) {
      await writeCache(videoId, 'sponsorblock', crowd);
      return reply({ source: 'sponsorblock', segments: crowd }, false);
    }
    if (cached) return reply(cached, true);
    return { ok: true, hasKey, cached: false, source: null, segments: [] };
  }

  async function classify(request, tabId) {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    if (typeof apiKey !== 'string' || !apiKey) return { ok: false, code: 'NO_KEY' };
    const settings = await getSettings();
    const controller = abortFor(tabId);
    try {
      const segments = await S.classifySegments({
        title: request.title,
        channel: request.channel,
        segments: request.segments,
        apiKey,
        endpoint: settings.endpoint,
        signal: controller.signal
      });
      await writeCache(request.videoId, 'ai', segments, MODEL);
      return { ok: true, cached: false, source: 'ai', segments: withIds(segments) };
    } catch (e) {
      if (e.name === 'AbortError') return { ok: false, code: 'ABORTED' };
      if (e.name === 'TimeoutError' || e instanceof TypeError) return { ok: false, code: 'NETWORK' };
      return { ok: false, code: typeof e.code === 'string' ? e.code : 'UNAVAILABLE' };
    }
  }

  function fromYouTubeTab(sender) {
    return sender.id === chrome.runtime.id && sender.tab && typeof sender.url === 'string' &&
      sender.url.startsWith('https://www.youtube.com/');
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!fromYouTubeTab(sender) || !S.isPlainObject(msg)) return false;
    const tabId = sender.tab.id;
    let job = null;
    if (msg.type === 'cancel') {
      const controller = controllers.get(tabId);
      if (controller) controller.abort();
      controllers.delete(tabId);
      return false;
    }
    if (msg.type === 'lookup' && S.isVideoId(msg.videoId)) job = lookup(msg.videoId, tabId);
    if (msg.type === 'classify') {
      const request = S.validateClassifyRequest(msg);
      job = request ? classify(request, tabId) : Promise.resolve({ ok: false, code: 'BAD_REQUEST' });
    }
    if (!job) return false;
    job.then(sendResponse, () => sendResponse({ ok: false, code: 'UNAVAILABLE' }));
    return true;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    const controller = controllers.get(tabId);
    if (controller) controller.abort();
    controllers.delete(tabId);
  });

  chrome.runtime.onInstalled.addListener(() => pruneCache().catch(() => {}));
  chrome.runtime.onStartup.addListener(() => pruneCache().catch(() => {}));
})();
