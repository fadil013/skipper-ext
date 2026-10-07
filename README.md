# Skipper

Skipper detects and skips sponsored segments on YouTube using crowd data and caption-based AI classification.

## Status

**Version 0.2.0, early release.**

Done:
- SponsorBlock lookup with AI fallback on captions
- Sponsor-only auto skip at 84% confidence, with uncertain markers and Undo
- Validated model output, hardened page/content messaging, local result cache
- Popup with settings and diagnostics
- 53 automated tests (`npm test`), all passing

Not yet verified:
- **Not tested in a real Chrome session yet.** Unit tests and static checks pass, but the extension has not been loaded and used on live YouTube videos.
- Caption capture depends on YouTube internals and may need fixes.
- AI classification quality has not been measured.

Bug reports are welcome.

## How it works

```
YouTube video
      ↓
SponsorBlock lookup ── sponsor segments found ──→ use them
      ↓ none
Captions → cleanup → ~30s segments
      ↓
AI classification (validated, untrusted input)
      ↓
Confidence  →  safe · uncertain · skip
      ↓
Merge neighbouring sponsors → seek-bar markers → skip
```

Skipper is conservative. If anything is unclear, invalid, late or missing, it does nothing.

## Features

- **SponsorBlock first.** Crowd data is used whenever it exists, with no AI request.
- **AI fallback** for videos nobody has labeled yet, based on the captions.
- **Sponsors only by default.** Intros, outros, self-promotion and "like and subscribe" are never skipped automatically.
- **Three confidence states.** Below 60% is ignored, 60–84% is shown as uncertain and not skipped, 84% and above is skipped.
- **Seek-bar markers**, thin and native-looking, with a tooltip showing the source, confidence and time range.
- **Undo** toast after every skip. Scrubbing into a sponsor never causes a skip loop.
- **No telemetry**, no accounts, no backend.

## Installation

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this folder.
3. Open the Skipper popup → **Settings**, paste an Anthropic API key and save. The key is only needed for the AI fallback; SponsorBlock works without it.

No build step and no dependencies. Requires Chrome 116 or newer.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| Auto skip | on | Turn off to only see markers. |
| Sponsor confidence | 84% | Skip threshold. |
| Show timeline | on | Markers on the YouTube seek bar. |
| API key / endpoint | Anthropic | A custom endpoint must speak the Anthropic Messages API, use HTTPS (or localhost), and is requested as an optional permission. |
| Advanced | | Uncertain threshold (60%), segment length (30s), minimum skip (4s), merge gap (2s), debug logging. |

Defaults live in `src/shared/config.js`.

## Privacy

- No analytics, tracking, or external logging.
- The API key lives in extension storage that is restricted to trusted extension contexts, so neither the page nor content scripts can read it. Only the background worker uses it.
- SponsorBlock is queried with a 4-character hash prefix of the video id, not the id itself.
- For uncached videos without crowd data, the video title, channel name and caption text are sent to the API endpoint you configured, under your own key.
- Results are cached locally (AI: 7 days, SponsorBlock: 6 hours).

### Permissions

| Permission | Why |
|---|---|
| `storage` | Settings, API key, result cache. |
| `https://sponsor.ajay.app/*` | Crowd-sourced sponsor segments. |
| `https://api.anthropic.com/*` | AI classification fallback. |
| Optional: other HTTPS / localhost origins | Only requested if you set a custom API endpoint. |
| Content script on `https://www.youtube.com/*` | Read captions, draw markers, seek the player. |

## Limitations

- AI detection depends on captions. Videos without captions get no AI analysis.
- Captions are obtained by observing the request YouTube's own player makes. YouTube can change that behavior and break it without notice.
- AI predictions can be wrong. Uncertain segments are intentionally not skipped.
- Only Chrome (Manifest V3) is supported and tested.

## Development

```
npm test      # Node's built-in test runner, no dependencies
```

```
src/
  background/   service worker, SponsorBlock client, AI classifier
  content/      captions, segmentation, skip engine, seek-bar timeline
  page/         caption-request hook (runs in the page world)
  popup/        popup UI
  shared/       config and validation
tests/
```

## Credits

Skipper was inspired in part by experiments such as [valentynkit/jev-skip](https://github.com/valentynkit/jev-skip), while following its own product and implementation direction.

## License

MIT, see `LICENSE`.
