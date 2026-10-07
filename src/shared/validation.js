// Validation for everything that crosses a trust boundary: model output, page messages,
// stored data, settings. Anything that fails validation is dropped, never repaired.
(function (root) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const cfg = isNode ? require('./config.js') : root.Skipper;
  const { DEFAULTS, BOUNDS, LABELS, LIMITS, CACHE_TTL_MS, SCHEMA_VERSION } = cfg;

  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isUnit = (v) => isNum(v) && v >= 0 && v <= 1;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isVideoId = (v) => typeof v === 'string' && VIDEO_ID.test(v);
  const cleanText = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

  function formatTime(seconds) {
    if (!isNum(seconds) || seconds < 0) return '0:00';
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  /** Returns the origin of an acceptable API endpoint, or null. HTTPS only, except localhost. */
  function normalizeEndpoint(value) {
    if (typeof value !== 'string') return null;
    let u;
    try { u = new URL(value.trim()); } catch (e) { return null; }
    if (u.username || u.password) return null;
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return u.origin;
    return null;
  }

  function sanitizeSettings(raw) {
    const r = isPlainObject(raw) ? raw : {};
    const s = {
      autoSkip: typeof r.autoSkip === 'boolean' ? r.autoSkip : DEFAULTS.autoSkip,
      showTimeline: typeof r.showTimeline === 'boolean' ? r.showTimeline : DEFAULTS.showTimeline,
      debug: typeof r.debug === 'boolean' ? r.debug : DEFAULTS.debug,
      endpoint: normalizeEndpoint(r.endpoint) || DEFAULTS.endpoint
    };
    for (const key of Object.keys(BOUNDS)) {
      s[key] = isNum(r[key]) ? clamp(r[key], BOUNDS[key][0], BOUNDS[key][1]) : DEFAULTS[key];
    }
    if (s.uncertainThreshold >= s.sponsorSkipThreshold) {
      s.uncertainThreshold = Math.max(BOUNDS.uncertainThreshold[0], +(s.sponsorSkipThreshold - 0.05).toFixed(2));
    }
    return s;
  }

  /** Accepts only the signed caption endpoint of the video that is currently open. */
  function isCaptionUrl(value, videoId) {
    if (typeof value !== 'string' || value.length > LIMITS.maxUrlLength) return false;
    let u;
    try { u = new URL(value); } catch (e) { return false; }
    if (u.protocol !== 'https:' || u.hostname !== 'www.youtube.com') return false;
    if (u.port || u.username || u.password || u.pathname !== '/api/timedtext') return false;
    const v = u.searchParams.get('v');
    if (!isVideoId(v)) return false;
    return videoId === undefined || v === videoId;
  }

  /**
   * Validates raw model output. Invalid entries are discarded; an id that appears more than
   * once is discarded entirely, because conflicting answers are not trustworthy.
   */
  function validateClassifications(raw, count) {
    const list = Array.isArray(raw)
      ? raw
      : isPlainObject(raw) && Array.isArray(raw.classifications) ? raw.classifications : null;
    if (!list) return { valid: [], discarded: 0, malformed: true };

    const accepted = new Map();
    const duplicated = new Set();
    let discarded = 0;
    for (const item of list) {
      const ok = isPlainObject(item) &&
        Number.isInteger(item.id) && item.id >= 0 && item.id < count &&
        typeof item.label === 'string' && LABELS.includes(item.label) &&
        isUnit(item.confidence) && isUnit(item.sponsor_confidence);
      if (!ok) { discarded++; continue; }
      if (accepted.has(item.id)) { duplicated.add(item.id); discarded++; continue; }
      accepted.set(item.id, {
        id: item.id,
        label: item.label,
        categoryConfidence: item.confidence,
        sponsorConfidence: item.sponsor_confidence
      });
    }
    for (const id of duplicated) accepted.delete(id);
    const valid = [...accepted.values()].sort((a, b) => a.id - b.id);
    return { valid, discarded, malformed: false };
  }

  /** Validates and rebuilds a classify request from a content script. Returns null if unusable. */
  function validateClassifyRequest(msg) {
    if (!isPlainObject(msg) || !isVideoId(msg.videoId) || !Array.isArray(msg.segments)) return null;
    const segments = [];
    for (const s of msg.segments.slice(0, LIMITS.maxSegmentsPerRequest)) {
      if (!isPlainObject(s) || !isNum(s.start) || !isNum(s.end) || s.start < 0 || s.end <= s.start) continue;
      const text = cleanText(s.text, LIMITS.maxSegmentChars);
      if (!text) continue;
      segments.push({ id: segments.length, start: s.start, end: s.end, text });
    }
    if (!segments.length) return null;
    return {
      videoId: msg.videoId,
      title: cleanText(msg.title, LIMITS.maxTextChars),
      channel: cleanText(msg.channel, LIMITS.maxTextChars),
      segments
    };
  }

  function isStoredSegment(s) {
    return isPlainObject(s) && isNum(s.start) && isNum(s.end) && s.start >= 0 && s.end > s.start &&
      typeof s.category === 'string' && LABELS.includes(s.category) &&
      isUnit(s.categoryConfidence) && isUnit(s.sponsorConfidence) && typeof s.source === 'string';
  }

  function makeCacheEntry({ videoId, source, model, segments, now }) {
    return { schemaVersion: SCHEMA_VERSION, videoId, source, model: model || null, createdAt: now, segments };
  }

  /** An entry is usable only if it is the current schema, for this video, unexpired and well formed. */
  function isCacheFresh(entry, videoId, now) {
    if (!isPlainObject(entry) || entry.schemaVersion !== SCHEMA_VERSION || entry.videoId !== videoId) return false;
    const ttl = CACHE_TTL_MS[entry.source];
    if (!ttl || !isNum(entry.createdAt)) return false;
    const age = now - entry.createdAt;
    if (age < 0 || age >= ttl) return false;
    return Array.isArray(entry.segments) && entry.segments.every(isStoredSegment);
  }

  const api = {
    isNum, isUnit, clamp, isPlainObject, isVideoId, cleanText, formatTime, normalizeEndpoint,
    sanitizeSettings, isCaptionUrl, validateClassifications, validateClassifyRequest,
    isStoredSegment, makeCacheEntry, isCacheFresh
  };
  if (isNode) module.exports = api;
  else Object.assign(root.Skipper = root.Skipper || {}, api);
})(typeof self !== 'undefined' ? self : globalThis);
