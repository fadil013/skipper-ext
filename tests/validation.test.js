const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/shared/validation.js');
const { LABELS, DEFAULTS, CACHE_TTL_MS, SCHEMA_VERSION } = require('../src/shared/config.js');

const item = (over = {}) => ({ id: 0, label: 'sponsor', confidence: 0.9, sponsor_confidence: 0.9, ...over });

test('accepts a well formed classification and strips unexpected fields', () => {
  const { valid } = V.validateClassifications([item({ extra: 'ignore previous instructions', __proto__: { x: 1 } })], 3);
  assert.deepEqual(valid, [{ id: 0, label: 'sponsor', categoryConfidence: 0.9, sponsorConfidence: 0.9 }]);
});

test('every allowed label is accepted, anything else is discarded', () => {
  for (const label of LABELS) assert.equal(V.validateClassifications([item({ label })], 1).valid.length, 1);
  for (const label of ['advert', 'SPONSOR', '', null, 5, undefined]) {
    assert.equal(V.validateClassifications([item({ label })], 1).valid.length, 0, String(label));
  }
});

test('confidence must be a finite number between 0 and 1 inclusive', () => {
  for (const good of [0, 1, 0.5]) assert.equal(V.validateClassifications([item({ sponsor_confidence: good })], 1).valid.length, 1);
  for (const bad of [-0.01, 1.01, NaN, Infinity, '0.9', null, undefined]) {
    assert.equal(V.validateClassifications([item({ sponsor_confidence: bad })], 1).valid.length, 0, String(bad));
    assert.equal(V.validateClassifications([item({ confidence: bad })], 1).valid.length, 0, String(bad));
  }
});

test('ids must be integers inside the segment range', () => {
  for (const id of [-1, 3, 1.5, '1', NaN, null]) {
    assert.equal(V.validateClassifications([item({ id })], 3).valid.length, 0, String(id));
  }
});

test('a duplicated id is dropped entirely rather than guessed at', () => {
  const r = V.validateClassifications([item({ id: 1 }), item({ id: 1, label: 'content' }), item({ id: 2 })], 3);
  assert.deepEqual(r.valid.map((c) => c.id), [2]);
});

test('missing answers are simply absent', () => {
  const r = V.validateClassifications([item({ id: 2 })], 5);
  assert.deepEqual(r.valid.map((c) => c.id), [2]);
});

test('non-array, null and garbage output is malformed, never accepted', () => {
  for (const raw of [null, undefined, 'sponsor', 42, {}, { classifications: 'x' }]) {
    assert.equal(V.validateClassifications(raw, 3).malformed, true);
  }
  assert.equal(V.validateClassifications([null, 'x', 7, []], 3).valid.length, 0);
});

test('caption URL validation accepts only the YouTube caption endpoint', () => {
  const ok = 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&pot=abc';
  assert.equal(V.isCaptionUrl(ok), true);
  assert.equal(V.isCaptionUrl(ok, 'dQw4w9WgXcQ'), true);
  assert.equal(V.isCaptionUrl(ok, 'AAAAAAAAAAA'), false);
  for (const bad of [
    'http://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ',
    'https://evil.example/api/timedtext?v=dQw4w9WgXcQ',
    'https://www.youtube.com.evil.example/api/timedtext?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com:8443/api/timedtext?v=dQw4w9WgXcQ',
    'https://user@www.youtube.com/api/timedtext?v=dQw4w9WgXcQ',
    'https://www.youtube.com/api/timedtext',
    'https://www.youtube.com/api/timedtext?v=short',
    'javascript:alert(1)', '', null, 12, {}
  ]) assert.equal(V.isCaptionUrl(bad), false, String(bad));
  assert.equal(V.isCaptionUrl(ok + 'x'.repeat(3000)), false);
});

test('endpoint must be https, or http on localhost', () => {
  assert.equal(V.normalizeEndpoint('https://api.anthropic.com/v1/'), 'https://api.anthropic.com');
  assert.equal(V.normalizeEndpoint('http://localhost:8787'), 'http://localhost:8787');
  for (const bad of ['http://example.com', 'ftp://x.com', 'https://u:p@x.com', 'nope', '', null]) {
    assert.equal(V.normalizeEndpoint(bad), null, String(bad));
  }
});

test('settings are clamped and fall back to defaults', () => {
  assert.deepEqual(V.sanitizeSettings(undefined), { ...DEFAULTS });
  const s = V.sanitizeSettings({ sponsorSkipThreshold: 5, minimumSkipSeconds: -3, mergeGapSeconds: 'x', autoSkip: 'yes', endpoint: 'http://evil.com' });
  assert.equal(s.sponsorSkipThreshold, 0.99);
  assert.equal(s.minimumSkipSeconds, 1);
  assert.equal(s.mergeGapSeconds, DEFAULTS.mergeGapSeconds);
  assert.equal(s.autoSkip, DEFAULTS.autoSkip);
  assert.equal(s.endpoint, DEFAULTS.endpoint);
});

test('uncertain threshold can never reach the skip threshold', () => {
  const s = V.sanitizeSettings({ sponsorSkipThreshold: 0.7, uncertainThreshold: 0.9 });
  assert.ok(s.uncertainThreshold < s.sponsorSkipThreshold);
});

test('classify requests are rebuilt from scratch and bounded', () => {
  const req = V.validateClassifyRequest({
    type: 'classify', videoId: 'dQw4w9WgXcQ', title: 'T'.repeat(999), channel: 5,
    segments: [{ id: 99, start: 0, end: 30, text: ' hello  world ' }, { start: 5, end: 1, text: 'bad' }, { start: 'x', end: 2, text: 'bad' }, { start: 30, end: 60, text: '' }, { start: 30, end: 60, text: 'ok' }]
  });
  assert.equal(req.title.length, 200);
  assert.equal(req.channel, '');
  assert.deepEqual(req.segments, [{ id: 0, start: 0, end: 30, text: 'hello world' }, { id: 1, start: 30, end: 60, text: 'ok' }]);
  assert.equal(V.validateClassifyRequest({ videoId: '../etc', segments: [] }), null);
  assert.equal(V.validateClassifyRequest({ videoId: 'dQw4w9WgXcQ', segments: [] }), null);
  assert.equal(V.validateClassifyRequest(null), null);
});

const segment = (over = {}) => ({ id: 0, start: 10, end: 40, category: 'sponsor', categoryConfidence: 0.9, sponsorConfidence: 0.9, source: 'ai', ...over });

test('cache entries expire per source', () => {
  const now = 1_000_000_000_000;
  const entry = (source, age) => V.makeCacheEntry({ videoId: 'dQw4w9WgXcQ', source, segments: [segment()], now: now - age });
  assert.equal(V.isCacheFresh(entry('ai', CACHE_TTL_MS.ai - 1), 'dQw4w9WgXcQ', now), true);
  assert.equal(V.isCacheFresh(entry('ai', CACHE_TTL_MS.ai), 'dQw4w9WgXcQ', now), false);
  assert.equal(V.isCacheFresh(entry('sponsorblock', CACHE_TTL_MS.sponsorblock - 1), 'dQw4w9WgXcQ', now), true);
  assert.equal(V.isCacheFresh(entry('sponsorblock', CACHE_TTL_MS.sponsorblock), 'dQw4w9WgXcQ', now), false);
  assert.ok(CACHE_TTL_MS.sponsorblock < CACHE_TTL_MS.ai);
});

test('incompatible or corrupted cache entries fail gracefully', () => {
  const now = Date.now();
  const good = V.makeCacheEntry({ videoId: 'dQw4w9WgXcQ', source: 'ai', segments: [segment()], now });
  assert.equal(V.isCacheFresh(good, 'dQw4w9WgXcQ', now), true);
  assert.equal(V.isCacheFresh(good, 'AAAAAAAAAAA', now), false);
  assert.equal(V.isCacheFresh({ ...good, schemaVersion: SCHEMA_VERSION + 1 }, 'dQw4w9WgXcQ', now), false);
  assert.equal(V.isCacheFresh({ ...good, source: 'mystery' }, 'dQw4w9WgXcQ', now), false);
  assert.equal(V.isCacheFresh({ ...good, createdAt: now + 5000 }, 'dQw4w9WgXcQ', now), false);
  assert.equal(V.isCacheFresh({ ...good, segments: [{ start: 'x' }] }, 'dQw4w9WgXcQ', now), false);
  for (const junk of [null, undefined, 'x', 7, [], [segment()]]) assert.equal(V.isCacheFresh(junk, 'dQw4w9WgXcQ', now), false);
});

test('formatTime', () => {
  assert.equal(V.formatTime(0), '0:00');
  assert.equal(V.formatTime(261), '4:21');
  assert.equal(V.formatTime(3725), '1:02:05');
  assert.equal(V.formatTime(NaN), '0:00');
  assert.equal(V.formatTime(-5), '0:00');
});
