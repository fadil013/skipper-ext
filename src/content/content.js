// Orchestrates one video at a time: SponsorBlock first, captions + AI as the fallback.
// Every await is followed by a generation check, so a result for a video the user has
// already left can never touch the current one.
(function (root) {
  'use strict';
  const S = root.Skipper;
  const doc = root.document;

  const guard = S.createGuard();
  const watcher = S.createCaptionWatcher(root);
  const timeline = S.createTimeline(doc);
  const getVideo = () => doc.querySelector('video.html5-main-video');

  let settings = S.sanitizeSettings(null);
  let controller = null;
  let toastTimer = null;
  let state = freshState(null);

  function freshState(videoId) {
    return {
      videoId, status: 'idle', captions: 0, transcriptSegments: 0, source: null,
      cached: false, lastError: null, segments: [], ranges: []
    };
  }

  function debug(...args) {
    if (settings.debug) console.debug('[Skipper]', ...args);
  }

  const send = (message) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (reply) => {
        void chrome.runtime.lastError;
        resolve(reply || null);
      });
    } catch (e) {
      resolve(null); // extension reloaded under us
    }
  });

  const currentVideoId = () => {
    if (root.location.pathname !== '/watch') return null;
    const id = new URLSearchParams(root.location.search).get('v');
    return S.isVideoId(id) ? id : null;
  };

  function showToast(text, onUndo) {
    clearTimeout(toastTimer);
    doc.querySelectorAll('.skipper-toast').forEach((n) => n.remove());
    const toast = doc.createElement('div');
    toast.className = 'skipper-toast';
    toast.textContent = text;
    const undo = doc.createElement('button');
    undo.type = 'button';
    undo.textContent = 'Undo';
    undo.addEventListener('click', () => { onUndo(); toast.remove(); });
    toast.appendChild(undo);
    (doc.getElementById('movie_player') || doc.body).appendChild(toast);
    toastTimer = setTimeout(() => toast.remove(), 5000);
  }

  const engine = S.createEngine({
    getVideo,
    canSkip: () => !doc.querySelector('.html5-video-player.ad-showing'), // never seek inside an ad
    onSkip({ range, from, to, undo }) {
      debug('skipped', range.id, from, to);
      showToast(`Skipped sponsor (${Math.round(to - from)}s)`, undo);
    }
  });

  /** Recompute ranges from the raw classified segments; called on new data, settings and duration changes. */
  function replan() {
    const video = getVideo();
    const duration = video ? video.duration : NaN;
    state.ranges = S.planRanges(state.segments, duration, settings);
    engine.setPlan(state.ranges, settings.autoSkip);
    timeline.render(state.ranges, duration, settings.showTimeline);
  }

  function invalidate() {
    guard.next();
    if (controller) controller.abort();
    controller = null;
    send({ type: 'cancel' });
    engine.reset();
    timeline.clear();
    watcher.forget();
    state = freshState(null);
  }

  function finish(g, status, error) {
    if (!guard.isCurrent(g)) return;
    state.status = status;
    state.lastError = error || null;
  }

  const channelName = () => {
    const el = doc.querySelector('ytd-watch-metadata ytd-channel-name a, ytd-channel-name a');
    return el ? el.textContent : '';
  };

  async function detect(videoId, g, signal) {
    const found = await send({ type: 'lookup', videoId });
    if (!guard.isCurrent(g)) return;
    if (!found || !found.ok) return finish(g, 'unavailable', found && found.code);

    if (found.segments.length) {
      state.segments = found.segments;
      state.source = found.source;
      state.cached = found.cached;
      replan();
      return finish(g, 'ready');
    }

    const url = await watcher.wait(videoId, signal);
    if (!guard.isCurrent(g)) return;
    if (!url) return finish(g, 'no-captions');

    const cues = await S.fetchCues(url, signal);
    if (!guard.isCurrent(g)) return;
    state.captions = cues.length;
    const segments = S.buildSegments(cues, { targetSeconds: settings.targetSegmentSeconds });
    state.transcriptSegments = segments.length;
    if (!segments.length) return finish(g, 'no-captions');
    if (!found.hasKey) return finish(g, 'no-key');

    const result = await send({
      type: 'classify',
      videoId,
      title: doc.title.replace(/ - YouTube$/, ''),
      channel: channelName(),
      segments
    });
    if (!guard.isCurrent(g)) return;
    if (!result || !result.ok) {
      const code = result && result.code;
      if (code === 'ABORTED') return;
      return finish(g, code === 'NETWORK' ? 'network' : code === 'NO_KEY' ? 'no-key' : 'unavailable', code);
    }
    state.segments = result.segments;
    state.source = result.source;
    state.cached = result.cached;
    replan();
    finish(g, 'ready');
  }

  async function run() {
    const videoId = currentVideoId();
    if (!videoId) return;
    if (videoId === state.videoId) return;
    invalidate();
    state = freshState(videoId);
    state.status = 'working';
    const g = guard.next();
    controller = new AbortController();
    try {
      await detect(videoId, g, controller.signal);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      debug('detection failed', e);
      finish(g, 'unavailable', 'error');
    }
  }

  async function loadSettings() {
    try {
      const { settings: stored } = await chrome.storage.sync.get('settings');
      settings = S.sanitizeSettings(stored);
    } catch (e) {
      settings = S.sanitizeSettings(null);
    }
  }

  function snapshot() {
    const video = getVideo();
    return {
      videoId: state.videoId,
      status: state.status,
      captions: state.captions,
      transcriptSegments: state.transcriptSegments,
      sponsors: state.ranges.filter((r) => r.state === S.STATE.SKIP).length,
      source: state.source,
      cached: state.cached,
      lastError: state.lastError,
      duration: video && Number.isFinite(video.duration) ? video.duration : 0,
      ranges: state.ranges.map((r) => ({ start: r.start, end: r.end, state: r.state, confidence: r.confidence, source: r.source }))
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !message || message.type !== 'status') return false;
    sendResponse(snapshot());
    return false;
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'sync' || !changes.settings) return;
    await loadSettings();
    replan();
  });

  doc.addEventListener('yt-navigate-start', invalidate);
  doc.addEventListener('yt-navigate-finish', run);
  doc.addEventListener('durationchange', replan, true);
  doc.addEventListener('loadedmetadata', replan, true);
  root.addEventListener('resize', replan);
  engine.start(doc);

  loadSettings().then(run);
})(self);
