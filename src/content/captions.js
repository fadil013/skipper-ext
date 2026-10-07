// Caption handling: receive the player-signed URL from the page hook, fetch it, and
// normalize the raw YouTube json3 events into clean { start, end, text } cues, once.
(function (root) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const cfg = isNode ? require('../shared/config.js') : root.Skipper;
  const val = isNode ? require('../shared/validation.js') : root.Skipper;
  const { LIMITS } = cfg;

  const OVERLAP_EPSILON = 0.5; // seconds: identical consecutive text this close is one cue

  function cueText(segs) {
    if (!Array.isArray(segs)) return '';
    return segs
      .map((s) => (val.isPlainObject(s) && typeof s.utf8 === 'string' ? s.utf8 : ''))
      .join('')
      .replace(/[​‌‍﻿]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Raw json3 events -> sorted, de-duplicated, non-overlapping cues. Never mutates the input. */
  function normalizeCues(events) {
    if (!Array.isArray(events)) return [];
    const cues = [];
    for (const ev of events) {
      if (!val.isPlainObject(ev) || !val.isNum(ev.tStartMs) || ev.tStartMs < 0) continue;
      const text = cueText(ev.segs);
      if (!text) continue;
      const start = ev.tStartMs / 1000;
      const duration = val.isNum(ev.dDurationMs) && ev.dDurationMs > 0 ? ev.dDurationMs / 1000 : 0;
      cues.push({ start, end: start + duration, text });
    }
    cues.sort((a, b) => a.start - b.start);

    const out = [];
    for (const cue of cues) {
      const prev = out[out.length - 1];
      if (prev && prev.text === cue.text && cue.start <= prev.end + OVERLAP_EPSILON) {
        prev.end = Math.max(prev.end, cue.end);
        continue;
      }
      if (prev && cue.start < prev.end) prev.end = Math.max(prev.start, cue.start);
      out.push({ start: cue.start, end: Math.max(cue.start, cue.end), text: cue.text });
    }
    return out;
  }

  function parseCaptionBody(body) {
    if (typeof body !== 'string' || !body) return [];
    try {
      const json = JSON.parse(body);
      return normalizeCues(val.isPlainObject(json) ? json.events : null);
    } catch (e) {
      return [];
    }
  }

  async function fetchCues(captionUrl, signal) {
    const url = new URL(captionUrl);
    url.searchParams.set('fmt', 'json3');
    const res = await fetch(url.toString(), { signal });
    if (!res.ok) throw new Error('caption_fetch');
    return parseCaptionBody(await res.text());
  }

  /**
   * Listens for caption URLs from the page hook. Every message is checked: same window,
   * same origin, expected shape, and a URL that passes isCaptionUrl. Anything else is ignored.
   */
  function createCaptionWatcher(win) {
    let latest = null;
    const waiters = new Set();

    function onMessage(event) {
      const d = event.data;
      if (event.source !== win || event.origin !== win.location.origin) return;
      if (!val.isPlainObject(d) || d.source !== 'skipper' || d.type !== 'caption-url') return;
      if (!val.isCaptionUrl(d.url)) return;
      latest = d.url;
      for (const wake of [...waiters]) wake();
    }
    win.addEventListener('message', onMessage);

    const urlFor = (videoId) => (latest && val.isCaptionUrl(latest, videoId) ? latest : null);

    /** Resolves with a caption URL for videoId, or null on timeout/abort. */
    function wait(videoId, signal) {
      return new Promise((resolve) => {
        let enableTimer = null;
        let timeoutTimer = null;
        function finish(result) {
          clearTimeout(enableTimer);
          clearTimeout(timeoutTimer);
          waiters.delete(check);
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        }
        function check() {
          const url = urlFor(videoId);
          if (url) finish(url);
        }
        function onAbort() { finish(null); }

        if (signal.aborted) return resolve(null);
        waiters.add(check);
        signal.addEventListener('abort', onAbort);
        enableTimer = setTimeout(
          () => win.postMessage({ source: 'skipper', type: 'enable-captions' }, win.location.origin),
          LIMITS.enableCaptionsAfterMs
        );
        timeoutTimer = setTimeout(() => finish(null), LIMITS.captionWaitMs);
        check();
      });
    }

    return { wait, forget() { latest = null; } };
  }

  const api = { normalizeCues, parseCaptionBody, fetchCues, createCaptionWatcher };
  if (isNode) module.exports = api;
  else Object.assign(root.Skipper = root.Skipper || {}, api);
})(typeof self !== 'undefined' ? self : globalThis);
