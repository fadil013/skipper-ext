// Thin sponsor markers on YouTube's own seek bar. Built with createElement/textContent only.
(function (root) {
  'use strict';
  const val = root.Skipper;
  const { STATE } = val;

  function createTimeline(doc) {
    let bar = null;
    let overlay = null;
    let tip = null;
    let ranges = [];
    let duration = 0;
    let listening = null;

    function detach() {
      if (listening) listening.abort();
      listening = null;
      if (overlay) overlay.remove();
      bar = overlay = tip = null;
    }

    function hideTip() { if (tip) tip.hidden = true; }

    function onMove(event) {
      if (!bar || !tip || !(duration > 0)) return;
      const rect = bar.getBoundingClientRect();
      if (!rect.width) return;
      const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const t = fraction * duration;
      const hit = ranges.find((r) => t >= r.start && t <= r.end);
      if (!hit) return hideTip();
      const lines = [
        'Sponsor',
        hit.source === 'sponsorblock' ? 'SponsorBlock' : `${Math.round(hit.confidence * 100)}% confidence`,
        `${val.formatTime(hit.start)} – ${val.formatTime(hit.end)}`
      ];
      tip.replaceChildren(...lines.map((text) => {
        const line = doc.createElement('div');
        line.textContent = text;
        return line;
      }));
      tip.style.left = fraction * 100 + '%';
      tip.hidden = false;
    }

    /** Make sure our overlay lives in the current progress bar (YouTube can recreate it). */
    function ensure() {
      const found = doc.querySelector('.ytp-progress-bar');
      if (!found) return false;
      if (found === bar && overlay && overlay.isConnected) return true;
      detach();
      bar = found;
      overlay = doc.createElement('div');
      overlay.className = 'skipper-timeline';
      tip = doc.createElement('div');
      tip.className = 'skipper-tip';
      tip.hidden = true;
      overlay.appendChild(tip);
      bar.appendChild(overlay);
      listening = new AbortController();
      bar.addEventListener('mousemove', onMove, { signal: listening.signal });
      bar.addEventListener('mouseleave', hideTip, { signal: listening.signal });
      return true;
    }

    function render(nextRanges, totalSeconds, visible) {
      ranges = nextRanges;
      duration = totalSeconds;
      if (!visible || !(totalSeconds > 0) || !nextRanges.length) {
        if (overlay) overlay.replaceChildren(tip);
        return;
      }
      if (!ensure()) return;
      const markers = nextRanges.map((r) => {
        const el = doc.createElement('div');
        el.className = 'skipper-marker' + (r.state === STATE.SKIP ? ' skipper-marker--skip' : '');
        el.style.left = (r.start / totalSeconds) * 100 + '%';
        el.style.width = ((r.end - r.start) / totalSeconds) * 100 + '%';
        return el;
      });
      overlay.replaceChildren(...markers, tip);
    }

    return { render, clear() { ranges = []; detach(); } };
  }

  Object.assign(val, { createTimeline });
})(typeof self !== 'undefined' ? self : globalThis);
