// Skip decisions and the playback engine. The decision functions are pure; the engine only
// ever seeks forward over a validated sponsor range, and any doubt means "do not skip".
(function (root) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const cfg = isNode ? require('../shared/config.js') : root.Skipper;
  const val = isNode ? require('../shared/validation.js') : root.Skipper;
  const { STATE } = cfg;

  const REPEAT_GUARD_MS = 1000; // never seek for the same range twice within this window
  const OWN_SEEK_MS = 1500;     // seeks we caused are ignored by the user-seek detector
  const END_MARGIN = 0.25;      // seconds before a range end where skipping is pointless

  /** SAFE below the uncertain threshold, SKIP at or above the skip threshold. Sponsors only. */
  function stateFor(seg, settings) {
    if (!seg || seg.category !== 'sponsor' || !val.isNum(seg.sponsorConfidence)) return STATE.SAFE;
    if (seg.sponsorConfidence >= settings.sponsorSkipThreshold) return STATE.SKIP;
    if (seg.sponsorConfidence >= settings.uncertainThreshold) return STATE.UNCERTAIN;
    return STATE.SAFE;
  }

  /**
   * Classified segments -> display/skip ranges. Neighbouring SKIP sponsors are merged when the
   * gap is small and the result stays sane. SKIP ranges that end up too short are dropped, and
   * ones that are too long are demoted to UNCERTAIN so they are shown but never skipped.
   */
  function planRanges(segments, duration, settings) {
    const hasDuration = val.isNum(duration) && duration > 0;
    const items = [];
    for (const seg of Array.isArray(segments) ? segments : []) {
      if (!seg || !val.isNum(seg.start) || !val.isNum(seg.end)) continue;
      const state = stateFor(seg, settings);
      if (state === STATE.SAFE) continue;
      const start = Math.max(0, seg.start);
      let end = seg.end;
      if (hasDuration) {
        if (start >= duration) continue;
        end = Math.min(end, duration);
      }
      if (end <= start) continue;
      items.push({ id: seg.id, start, end, state, confidence: seg.sponsorConfidence, source: seg.source });
    }
    items.sort((a, b) => a.start - b.start);

    const merged = [];
    for (const it of items) {
      const prev = merged[merged.length - 1];
      const mergeable = prev && prev.state === STATE.SKIP && it.state === STATE.SKIP &&
        it.start - prev.end <= settings.mergeGapSeconds &&
        Math.max(prev.end, it.end) - prev.start <= settings.maximumSkipSeconds;
      if (mergeable) {
        prev.end = Math.max(prev.end, it.end);
        prev.confidence = Math.min(prev.confidence, it.confidence);
      } else merged.push(Object.assign({}, it));
    }

    return merged
      .map((r) => (r.state === STATE.SKIP && r.end - r.start > settings.maximumSkipSeconds
        ? Object.assign({}, r, { state: STATE.UNCERTAIN }) : r))
      .filter((r) => r.state !== STATE.SKIP || r.end - r.start >= settings.minimumSkipSeconds);
  }

  /** The SKIP range that playback position `now` is inside, unless it is suppressed. */
  function findSkip(now, ranges, suppressed) {
    if (!val.isNum(now)) return null;
    return ranges.find((r) => r.state === STATE.SKIP && !suppressed.has(r.id) &&
      now >= r.start && now < r.end - END_MARGIN) || null;
  }

  /** Generation counter: a result is applied only if no navigation happened since it started. */
  function createGuard() {
    let generation = 0;
    return {
      next: () => ++generation,
      current: () => generation,
      isCurrent: (g) => g === generation
    };
  }

  /**
   * Playback engine. `getVideo` returns the <video>; `onSkip` is told about each skip.
   * State is explicit: the plan, ranges suppressed after a skip/undo/user seek, and whether
   * the user is currently scrubbing.
   */
  function createEngine({ getVideo, onSkip, canSkip = () => true, now = Date.now }) {
    let ranges = [];
    let enabled = true;
    let userSeeking = false;
    let ownSeekUntil = 0;
    let lastSkip = { id: null, at: 0 };
    const suppressed = new Set();
    let listeners = null;

    function seek(video, to) {
      ownSeekUntil = now() + OWN_SEEK_MS;
      video.currentTime = to;
    }

    function releaseSuppressed(time) {
      for (const id of [...suppressed]) {
        const r = ranges.find((x) => x.id === id);
        if (!r || time < r.start || time >= r.end) suppressed.delete(id);
      }
    }

    function onTimeUpdate() {
      const video = getVideo();
      if (!video || !enabled || userSeeking || !canSkip()) return;
      const time = video.currentTime;
      releaseSuppressed(time);
      const range = findSkip(time, ranges, suppressed);
      if (!range) return;
      const duration = video.duration;
      const target = val.isNum(duration) ? Math.min(range.end, duration) : NaN;
      if (!val.isNum(target) || target <= time) return;
      if (lastSkip.id === range.id && now() - lastSkip.at < REPEAT_GUARD_MS) return;

      lastSkip = { id: range.id, at: now() };
      suppressed.add(range.id);
      seek(video, target);
      if (onSkip) {
        onSkip({
          range,
          from: time,
          to: target,
          undo() { suppressed.add(range.id); seek(video, time); }
        });
      }
    }

    function onSeeking() {
      if (now() < ownSeekUntil) return;
      userSeeking = true;
    }

    function onSeeked() {
      const video = getVideo();
      if (now() < ownSeekUntil && !userSeeking) return;
      userSeeking = false;
      if (!video) return;
      // The user chose to be here: do not skip the sponsor range they just landed in.
      const inside = ranges.find((r) => video.currentTime >= r.start && video.currentTime < r.end);
      if (inside) suppressed.add(inside.id);
    }

    return {
      setPlan(next, autoSkip) {
        ranges = next;
        enabled = autoSkip;
        releaseSuppressed(NaN);
      },
      reset() {
        ranges = [];
        userSeeking = false;
        ownSeekUntil = 0;
        lastSkip = { id: null, at: 0 };
        suppressed.clear();
      },
      onTimeUpdate, onSeeking, onSeeked,
      start(doc) {
        if (listeners) return;
        listeners = new AbortController();
        const opts = { capture: true, signal: listeners.signal };
        const mine = (fn) => (e) => { if (e.target === getVideo()) fn(); };
        doc.addEventListener('timeupdate', mine(onTimeUpdate), opts);
        doc.addEventListener('seeking', mine(onSeeking), opts);
        doc.addEventListener('seeked', mine(onSeeked), opts);
      },
      stop() {
        if (listeners) listeners.abort();
        listeners = null;
      }
    };
  }

  const api = { stateFor, planRanges, findSkip, createGuard, createEngine };
  if (isNode) module.exports = api;
  else Object.assign(root.Skipper = root.Skipper || {}, api);
})(typeof self !== 'undefined' ? self : globalThis);
