// Groups cues into ~30 second segments, preferring sentence ends and natural pauses.
// Deterministic: the same cues and options always give the same segments.
(function (root) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;

  const NATURAL_GAP_SECONDS = 1;
  const TINY_TAIL_SECONDS = 8;

  const endsSentence = (text) => /[.!?]["')\]]?$/.test(text);

  function buildSegments(cues, { targetSeconds = 30 } = {}) {
    const min = targetSeconds - 5; // earliest we will cut, at a sentence end or pause
    const hard = Math.round(targetSeconds * 1.5);
    const segments = [];
    let cur = null;

    const close = () => { segments.push(cur); cur = null; };

    cues.forEach((cue, i) => {
      if (!cur) cur = { start: cue.start, end: cue.end, text: cue.text };
      else {
        cur.end = Math.max(cur.end, cue.end);
        cur.text += ' ' + cue.text;
      }
      const length = cur.end - cur.start;
      const next = cues[i + 1];
      const gap = next ? next.start - cue.end : Infinity;
      const naturalBreak = endsSentence(cue.text) || gap >= NATURAL_GAP_SECONDS;
      if (length >= hard || (length >= min && naturalBreak)) close();
    });
    if (cur) {
      const prev = segments[segments.length - 1];
      if (prev && cur.end - cur.start < TINY_TAIL_SECONDS) {
        prev.end = cur.end;
        prev.text += ' ' + cur.text;
      } else segments.push(cur);
    }
    return segments.map((s, id) => ({ id, start: s.start, end: s.end, text: s.text }));
  }

  const api = { buildSegments };
  if (isNode) module.exports = api;
  else Object.assign(root.Skipper = root.Skipper || {}, api);
})(typeof self !== 'undefined' ? self : globalThis);
