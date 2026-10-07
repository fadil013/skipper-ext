// Runs in the YouTube page world. YouTube only answers caption requests that carry a token
// minted by its own player, so we cannot build a valid caption URL ourselves. Instead we
// observe the URL the player requests and pass it to the content script, which re-validates
// it before using it. This relies on YouTube internals and may need updating if they change.
(function () {
  'use strict';
  if (window.__skipperHook) return;
  Object.defineProperty(window, '__skipperHook', { value: true });

  const CAPTION_PATH = '/api/timedtext';

  function report(url) {
    let text;
    try { text = typeof url === 'string' ? url : url && (url.url || String(url)); } catch (e) { return; }
    if (typeof text !== 'string' || text.indexOf(CAPTION_PATH) === -1) return;
    window.postMessage({ source: 'skipper', type: 'caption-url', url: text }, window.location.origin);
  }

  const nativeFetch = window.fetch;
  window.fetch = function (input) {
    report(input);
    return Reflect.apply(nativeFetch, this, arguments);
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    report(url);
    return Reflect.apply(nativeOpen, this, arguments);
  };

  // The content script asks for captions to be switched on when the player has not loaded any.
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window || !data || data.source !== 'skipper' || data.type !== 'enable-captions') return;
    const player = document.getElementById('movie_player');
    if (player && typeof player.toggleSubtitlesOn === 'function') player.toggleSubtitlesOn();
  });
})();
