// SponsorBlock lookup. Queried by a 4-character hash prefix so the video id itself is not sent.
(function (root) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const cfg = isNode ? require('../shared/config.js') : root.Skipper;
  const val = isNode ? require('../shared/validation.js') : root.Skipper;
  const { SPONSORBLOCK_CATEGORIES } = cfg;
  const API = 'https://sponsor.ajay.app/api/skipSegments/';

  async function hashPrefix(videoId) {
    const bytes = new TextEncoder().encode(videoId);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 4);
  }

  /** Converts the API response for one video into our segment shape, dropping anything malformed. */
  function toSegments(json, videoId) {
    if (!Array.isArray(json)) return [];
    const entry = json.find((v) => val.isPlainObject(v) && v.videoID === videoId);
    if (!entry || !Array.isArray(entry.segments)) return [];
    const out = [];
    for (const s of entry.segments) {
      if (!val.isPlainObject(s) || !Array.isArray(s.segment)) continue;
      const [start, end] = s.segment;
      const label = SPONSORBLOCK_CATEGORIES[s.category];
      if (!label || !val.isNum(start) || !val.isNum(end) || start < 0 || end <= start) continue;
      out.push({
        id: out.length,
        start,
        end,
        category: label,
        categoryConfidence: 1,
        sponsorConfidence: label === 'sponsor' ? 1 : 0,
        source: 'sponsorblock'
      });
    }
    return out;
  }

  const hasSponsor = (segments) => segments.some((s) => s.category === 'sponsor');

  async function fetchSegments(videoId, signal) {
    const categories = encodeURIComponent(JSON.stringify(Object.keys(SPONSORBLOCK_CATEGORIES)));
    const url = `${API}${await hashPrefix(videoId)}?categories=${categories}&actionType=skip`;
    const res = await fetch(url, { signal });
    if (res.status === 404) return [];
    if (!res.ok) throw Object.assign(new Error('sponsorblock'), { code: `sb_${res.status}` });
    return toSegments(await res.json(), videoId);
  }

  const api = { toSegments, hasSponsor, fetchSegments };
  if (isNode) module.exports = api;
  else Object.assign(root.Skipper = root.Skipper || {}, api);
})(typeof self !== 'undefined' ? self : globalThis);
