(function () {
  'use strict';
  const S = self.Skipper;
  const $ = (id) => document.getElementById(id);

  const MESSAGES = {
    idle: ['Idle', ''],
    working: ['Analyzing', ''],
    ready: ['Ready', ''],
    'no-captions': ['No captions', "Captions aren't available for this video."],
    'no-key': ['API key needed', 'Add an API key to enable AI fallback.'],
    unavailable: ['Unavailable', "Detection couldn't run for this video."],
    network: ['Offline', "Couldn't reach the classification service."]
  };
  const NO_VIDEO = ['No video', 'Open a YouTube video to see detection results.'];

  let settings = S.sanitizeSettings(null);

  const pct = (v) => Math.round(v * 100) + '%';
  const text = (id, value) => { $(id).textContent = value; };

  function saveSettings() {
    return chrome.storage.sync.set({ settings });
  }

  function paintSettings() {
    $('autoSkip').checked = settings.autoSkip;
    $('showTimeline').checked = settings.showTimeline;
    $('debug').checked = settings.debug;
    $('sponsorSkipThreshold').value = settings.sponsorSkipThreshold;
    $('uncertainThreshold').value = settings.uncertainThreshold;
    $('targetSegmentSeconds').value = settings.targetSegmentSeconds;
    $('minimumSkipSeconds').value = settings.minimumSkipSeconds;
    $('mergeGapSeconds').value = settings.mergeGapSeconds;
    $('endpoint').value = settings.endpoint;
    text('thresholdOut', pct(settings.sponsorSkipThreshold));
    text('uncertainOut', pct(settings.uncertainThreshold));
    text('targetOut', settings.targetSegmentSeconds + 's');
    text('minOut', settings.minimumSkipSeconds + 's');
    text('gapOut', settings.mergeGapSeconds + 's');
    $('pill').classList.toggle('off', !settings.autoSkip);
    text('pill-text', settings.autoSkip ? 'Active' : 'Paused');
  }

  function bind(id, key, parse) {
    $(id).addEventListener('input', () => {
      settings = S.sanitizeSettings(Object.assign({}, settings, { [key]: parse($(id)) }));
      paintSettings();
      saveSettings();
    });
  }
  bind('autoSkip', 'autoSkip', (el) => el.checked);
  bind('showTimeline', 'showTimeline', (el) => el.checked);
  bind('debug', 'debug', (el) => el.checked);
  for (const key of ['sponsorSkipThreshold', 'uncertainThreshold', 'targetSegmentSeconds', 'minimumSkipSeconds', 'mergeGapSeconds']) {
    bind(key, key, (el) => Number(el.value));
  }

  // --- API key and endpoint -------------------------------------------------------------

  function flash(message, isError) {
    const el = $('saved');
    el.textContent = message;
    el.classList.toggle('error', Boolean(isError));
    setTimeout(() => { el.textContent = ''; }, 2500);
  }

  async function refreshKeyState() {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    const has = typeof apiKey === 'string' && apiKey.length > 0;
    $('apiKey').placeholder = has ? 'Key saved. Enter a new one to replace it.' : 'sk-ant-...';
    $('removeKey').hidden = !has;
  }

  $('saveApi').addEventListener('click', async () => {
    const endpoint = S.normalizeEndpoint($('endpoint').value);
    if (!endpoint) return flash('Endpoint must be https (or localhost).', true);
    try {
      if (endpoint !== S.DEFAULTS.endpoint) {
        const granted = await chrome.permissions.request({ origins: [endpoint + '/*'] });
        if (!granted) return flash('Permission for that endpoint was denied.', true);
      }
      settings = S.sanitizeSettings(Object.assign({}, settings, { endpoint }));
      await saveSettings();
      const key = $('apiKey').value.trim();
      if (key) await chrome.storage.local.set({ apiKey: key });
      $('apiKey').value = '';
      paintSettings();
      await refreshKeyState();
      flash('Saved');
    } catch (e) {
      flash("Couldn't save.", true);
    }
  });

  $('removeKey').addEventListener('click', async () => {
    await chrome.storage.local.remove('apiKey');
    await refreshKeyState();
    flash('Key removed');
  });

  // --- current video --------------------------------------------------------------------

  function paintTimeline(info) {
    const line = $('timeline');
    line.replaceChildren();
    text('t-end', S.formatTime(info ? info.duration : 0));
    if (!info || !(info.duration > 0)) return;
    for (const r of info.ranges) {
      const span = document.createElement('span');
      if (r.state === S.STATE.SKIP) span.className = 'skip';
      span.style.left = (r.start / info.duration) * 100 + '%';
      span.style.width = ((r.end - r.start) / info.duration) * 100 + '%';
      line.appendChild(span);
    }
  }

  function paintDiagnostics(info) {
    const rows = info ? [
      ['Video ID', info.videoId || 'none'],
      ['Caption status', info.captions ? `${info.captions} cues` : info.status === 'no-captions' ? 'none' : 'not loaded'],
      ['Detection source', info.source === 'sponsorblock' ? 'SponsorBlock' : info.source === 'ai' ? 'AI' : 'none'],
      ['Transcript segments', String(info.transcriptSegments)],
      ['Sponsor segments', String(info.sponsors)],
      ['Classification', (MESSAGES[info.status] || MESSAGES.idle)[0]],
      ['Result', info.source ? (info.cached ? 'cached' : 'fresh') : 'none'],
      ['Last error', info.lastError || 'none']
    ] : [['Page', 'No YouTube video open']];
    $('diag').replaceChildren(...rows.map(([label, value]) => {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value;
      row.append(dt, dd);
      return row;
    }));
  }

  function paintVideo(info) {
    const [label, note] = info ? (MESSAGES[info.status] || MESSAGES.idle) : NO_VIDEO;
    text('v-status', label);
    text('v-captions', info && info.captions ? String(info.captions) : '–');
    text('v-segments', info && info.transcriptSegments ? String(info.transcriptSegments) : '–');
    text('v-sponsors', info && info.status === 'ready' ? String(info.sponsors) : '–');
    $('note').hidden = !note;
    text('note', note);
    paintTimeline(info);
    paintDiagnostics(info);
  }

  async function loadVideo() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      paintVideo(tab ? await chrome.tabs.sendMessage(tab.id, { type: 'status' }) : null);
    } catch (e) {
      paintVideo(null); // not a YouTube tab, or the page has no content script yet
    }
  }

  // --- navigation -----------------------------------------------------------------------

  function show(view) {
    for (const name of ['main', 'settings', 'diagnostics']) {
      $('view-' + name).hidden = name !== view;
    }
    $('nav-settings').classList.toggle('active', view === 'settings');
    $('nav-diagnostics').classList.toggle('active', view === 'diagnostics');
  }
  $('nav-settings').addEventListener('click', () => show($('view-settings').hidden ? 'settings' : 'main'));
  $('nav-diagnostics').addEventListener('click', () => show($('view-diagnostics').hidden ? 'diagnostics' : 'main'));

  chrome.storage.sync.get('settings').then((stored) => {
    settings = S.sanitizeSettings(stored.settings);
    paintSettings();
  });
  refreshKeyState();
  loadVideo();
})();
