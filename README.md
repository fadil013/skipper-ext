# Skipper

Chrome extension that skips YouTube sponsor segments, including on videos nobody has labeled.

1. Looks the video up in SponsorBlock's crowd database (instant, free, by hash prefix).
2. If nothing is there, reads the video's captions and asks Claude Haiku 4.5 which ~30s windows are sponsors, self-promo, intros, outros or like/subscribe begging.
3. Paints the seek bar (confident slices solid, doubtful ones faint) and skips anything above your threshold, with an Undo toast.

## Install

`chrome://extensions` → Developer mode → Load unpacked → pick this folder → open the popup and paste your Anthropic API key.

No build step, no dependencies. Your key stays in extension storage and is only sent to api.anthropic.com.

## Limits

Videos without captions get no AI analysis. The caption capture relies on YouTube's player requesting captions itself, which YouTube may change.

## Credits

The idea of skipping unlabeled sponsors from captions was inspired by [valentynkit/jev-skip](https://github.com/valentynkit/jev-skip). This codebase is an independent implementation and shares no code with it.

## License

MIT
