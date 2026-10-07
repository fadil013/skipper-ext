// Runs in the page world. Remembers the caption URL the YouTube player itself requests,
// because only the player can mint the token that makes that URL return data.
(() => {
  const announce = (url) => {
    if (typeof url === "string" && url.includes("/api/timedtext") && url.includes("v=")) {
      window.postMessage({ source: "skipper", type: "caption-url", url }, "*");
    }
  };
  const realFetch = window.fetch;
  window.fetch = function (input) {
    try { announce(typeof input === "string" ? input : input && input.url); } catch (e) {}
    return realFetch.apply(this, arguments);
  };
  const realOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { announce(String(url)); } catch (e) {}
    return realOpen.apply(this, arguments);
  };
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.source === "skipper" && e.data.type === "enable-captions") {
      const p = document.getElementById("movie_player");
      try { if (p && p.toggleSubtitlesOn) p.toggleSubtitlesOn(); } catch (err) {}
    }
  });
})();
