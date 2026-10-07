const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCues, parseCaptionBody } = require('../src/content/captions.js');
const { buildSegments } = require('../src/content/segmentation.js');

const ev = (startSec, durSec, text) => ({ tStartMs: startSec * 1000, dDurationMs: durSec * 1000, segs: [{ utf8: text }] });

test('normalizes whitespace and drops empty or malformed cues', () => {
  const cues = normalizeCues([
    ev(0, 2, '  hello \n  world  '),
    { tStartMs: 1000, dDurationMs: 1000 },                 // no segs
    { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: '\n' }] },
    { tStartMs: -5, dDurationMs: 1000, segs: [{ utf8: 'neg' }] },
    { tStartMs: NaN, dDurationMs: 1000, segs: [{ utf8: 'nan' }] },
    { tStartMs: 'x', dDurationMs: 1000, segs: [{ utf8: 'str' }] },
    null, 'x', 7,
    { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: 'a​' }, { nope: 1 }, { utf8: 'b' }] }
  ]);
  assert.deepEqual(cues, [
    { start: 0, end: 2, text: 'hello world' },
    { start: 5, end: 6, text: 'ab' }
  ]);
});

test('non-finite or missing durations become zero-length, never NaN', () => {
  const cues = normalizeCues([{ tStartMs: 1000, dDurationMs: NaN, segs: [{ utf8: 'x' }] }, { tStartMs: 3000, segs: [{ utf8: 'y' }] }]);
  assert.deepEqual(cues, [{ start: 1, end: 1, text: 'x' }, { start: 3, end: 3, text: 'y' }]);
});

test('removes duplicate consecutive cues and extends the first', () => {
  const cues = normalizeCues([ev(0, 2, 'same'), ev(2, 2, 'same'), ev(10, 2, 'same')]);
  assert.deepEqual(cues, [{ start: 0, end: 4, text: 'same' }, { start: 10, end: 12, text: 'same' }]);
});

test('trims overlapping cues and sorts by start while preserving timing', () => {
  const cues = normalizeCues([ev(4, 4, 'second'), ev(0, 6, 'first')]);
  assert.deepEqual(cues, [{ start: 0, end: 4, text: 'first' }, { start: 4, end: 8, text: 'second' }]);
});

test('does not mutate the raw events', () => {
  const raw = [ev(0, 2, ' a '), ev(1, 2, 'b')];
  const copy = JSON.parse(JSON.stringify(raw));
  normalizeCues(raw);
  assert.deepEqual(raw, copy);
});

test('parseCaptionBody tolerates garbage', () => {
  for (const body of ['', 'not json', '{"events":"x"}', '[]', null, undefined, 5]) assert.deepEqual(parseCaptionBody(body), []);
  assert.equal(parseCaptionBody(JSON.stringify({ events: [ev(0, 1, 'hi')] })).length, 1);
});

const sentences = (count, spacing = 5) =>
  Array.from({ length: count }, (_, i) => ({ start: i * spacing, end: i * spacing + spacing, text: `Sentence number ${i}.` }));

test('segments are about 30 seconds, cut at sentence ends, and cover all cues in order', () => {
  const segs = buildSegments(sentences(40), { targetSeconds: 30 });
  assert.ok(segs.length >= 5 && segs.length <= 8, `got ${segs.length}`);
  segs.forEach((s, i) => assert.equal(s.id, i));
  for (const s of segs.slice(0, -1)) {
    const len = s.end - s.start;
    assert.ok(len >= 25 && len <= 45, `length ${len}`);
    assert.match(s.text, /\.$/);
  }
  for (let i = 1; i < segs.length; i++) assert.ok(segs[i].start >= segs[i - 1].end - 1e-9);
  assert.equal(segs[0].start, 0);
  assert.equal(segs[segs.length - 1].end, 200);
});

test('unpunctuated captions are cut at the hard maximum, not left as one giant chunk', () => {
  const cues = Array.from({ length: 60 }, (_, i) => ({ start: i * 3, end: i * 3 + 3, text: 'word word' }));
  const segs = buildSegments(cues, { targetSeconds: 30 });
  assert.ok(segs.every((s) => s.end - s.start <= 48));
  assert.ok(segs.length >= 4);
});

test('a tiny trailing fragment is folded into the previous segment', () => {
  const cues = [...sentences(5), { start: 25, end: 28, text: 'Bye.' }];
  const segs = buildSegments(cues, { targetSeconds: 30 });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].end, 28);
});

test('segmentation is deterministic and handles empty input', () => {
  const cues = sentences(30);
  assert.deepEqual(buildSegments(cues), buildSegments(cues));
  assert.deepEqual(buildSegments([]), []);
});

test('caption watcher ignores spoofed, foreign-origin and wrong-video messages', async () => {
  const { createCaptionWatcher } = require('../src/content/captions.js');
  const handlers = [];
  const win = {
    location: { origin: 'https://www.youtube.com' },
    addEventListener: (type, fn) => handlers.push(fn),
    postMessage() {}
  };
  const watcher = createCaptionWatcher(win);
  const send = (over) => handlers[0]({
    source: win, origin: 'https://www.youtube.com',
    data: { source: 'skipper', type: 'caption-url', url: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&pot=1' },
    ...over
  });
  const ctl = new AbortController();

  send({ source: {} });                                         // wrong window
  send({ origin: 'https://evil.example' });                     // wrong origin
  send({ data: { source: 'skipper', type: 'caption-url', url: 'https://evil.example/api/timedtext?v=dQw4w9WgXcQ' } });
  send({ data: { source: 'other', type: 'caption-url', url: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ' } });
  send({ data: null });
  setTimeout(() => ctl.abort(), 20);
  assert.equal(await watcher.wait('dQw4w9WgXcQ', ctl.signal), null);

  send({});                                                      // genuine message
  assert.match(await watcher.wait('dQw4w9WgXcQ', new AbortController().signal), /timedtext/);
  const other = new AbortController();
  setTimeout(() => other.abort(), 20);
  assert.equal(await watcher.wait('AAAAAAAAAAA', other.signal), null, 'url for a different video is never returned');
});
