const $ = (id) => document.getElementById(id);
chrome.storage.local.get(["apiKey", "threshold", "enabled", "lastRun"]).then((s) => {
  $("key").value = s.apiKey || "";
  $("threshold").value = typeof s.threshold === "number" ? s.threshold : 0.7;
  $("tv").textContent = $("threshold").value;
  $("enabled").checked = s.enabled !== false;
  if (s.lastRun) {
    const r = s.lastRun;
    $("last").innerHTML = "<small>Last run: " + r.segments + " segments, " + r.windows + " windows, " +
      (r.inputTokens + r.outputTokens) + " tokens</small>";
  }
});
$("key").onchange = () => chrome.storage.local.set({ apiKey: $("key").value.trim() });
$("threshold").oninput = () => {
  $("tv").textContent = $("threshold").value;
  chrome.storage.local.set({ threshold: +$("threshold").value });
};
$("enabled").onchange = () => chrome.storage.local.set({ enabled: $("enabled").checked });
$("clear").onclick = async () => {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith("seg:")));
  $("clear").textContent = "Cleared";
};
