const test = require('node:test');
const assert = require('node:assert/strict');
const { stateFor, planRanges, findSkip, createGuard, createEngine } = require('../src/content/skipper.js');
const { DEFAULTS, STATE } = require('../src/shared/config.js');

const cfg = { ...DEFAULTS };
const sponsor = (start, end, p, over = {}) => ({ id: over.id ?? start, start, end, category: 'sponsor', categoryConfidence: 0.9, sponsorConfidence: p, source: 'ai', ...over });

test('0.839 does not skip, 0.840 does (default threshold 0.84)', () => {
  assert.equal(stateFor(sponsor(0, 30, 0.839), cfg), STATE.UNCERTAIN);
  assert.equal(stateFor(sponsor(0, 30, 0.84), cfg), STATE.SKIP);
});

test('three confidence states', () => {
  assert.equal(stateFor(sponsor(0, 30, 0.59), cfg), STATE.SAFE);
  assert.equal(stateFor(sponsor(0, 30, 0.6), cfg), STATE.UNCERTAIN);
  assert.equal(stateFor(sponsor(0, 30, 0.72), cfg), STATE.UNCERTAIN);
  assert.equal(stateFor(sponsor(0, 30, 0.94), cfg), STATE.SKIP);
});

test('only paid sponsors are ever skipped, however confident the model is', () => {
  for (const category of ['intro', 'outro', 'self_promo', 'interaction', 'recap', 'other', 'content']) {
    assert.equal(stateFor(sponsor(0, 30, 1, { category }), cfg), STATE.SAFE, category);
  }
  assert.equal(stateFor(null, cfg), STATE.SAFE);
  assert.equal(stateFor(sponsor(0, 30, NaN), cfg), STATE.SAFE);
});

test('adjacent sponsor segments merge, distant ones do not', () => {
  const near = planRanges([sponsor(261, 288, 0.9), sponsor(289, 317, 0.95)], 600, cfg);
  assert.equal(near.length, 1);
  assert.equal(near[0].start, 261);
  assert.equal(near[0].end, 317);
  assert.equal(near[0].confidence, 0.9);
  const far = planRanges([sponsor(100, 130, 0.9), sponsor(200, 230, 0.9)], 600, cfg);
  assert.equal(far.length, 2);
  const justOver = planRanges([sponsor(100, 130, 0.9), sponsor(132.5, 160, 0.9)], 600, cfg);
  assert.equal(justOver.length, 2);
});

test('an uncertain neighbour never merges into a skip range', () => {
  const r = planRanges([sponsor(100, 130, 0.95), sponsor(131, 160, 0.7)], 600, cfg);
  assert.deepEqual(r.map((x) => x.state), [STATE.SKIP, STATE.UNCERTAIN]);
  assert.equal(r[0].end, 130);
});

test('minimum skip duration: short sponsor ranges are dropped', () => {
  assert.equal(planRanges([sponsor(10, 13.9, 0.95)], 600, cfg).length, 0);
  assert.equal(planRanges([sponsor(10, 14, 0.95)], 600, cfg).length, 1);
});

test('maximum skip duration: oversized ranges are shown but demoted, merging stops at the cap', () => {
  const huge = planRanges([sponsor(0, 200, 0.99)], 600, cfg);
  assert.equal(huge.length, 1);
  assert.equal(huge[0].state, STATE.UNCERTAIN);
  const atCap = planRanges([sponsor(0, 180, 0.99)], 600, cfg);
  assert.equal(atCap[0].state, STATE.SKIP);
  const chain = planRanges([sponsor(0, 100, 0.99, { id: 1 }), sponsor(101, 200, 0.99, { id: 2 })], 600, cfg);
  assert.equal(chain.length, 2, 'would exceed 180s so they stay separate');
  assert.ok(chain.every((r) => r.end - r.start <= cfg.maximumSkipSeconds));
});

test('ranges are clamped to the video: no negatives, nothing beyond the duration', () => {
  const r = planRanges([sponsor(-10, 20, 0.95), sponsor(590, 700, 0.95), sponsor(900, 960, 0.95)], 600, cfg);
  assert.deepEqual(r.map((x) => [x.start, x.end]), [[0, 20], [590, 600]]);
});

test('malformed segments are ignored', () => {
  const bad = [null, {}, sponsor(NaN, 5, 0.9), sponsor(5, 5, 0.9), sponsor(9, 3, 0.9), sponsor(0, Infinity, 0.9)];
  assert.deepEqual(planRanges(bad, 600, cfg), []);
  assert.deepEqual(planRanges(null, 600, cfg), []);
});

test('stale video response protection: an old generation is never current', () => {
  const guard = createGuard();
  const first = guard.next();
  assert.equal(guard.isCurrent(first), true);
  const second = guard.next();           // user navigated
  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.isCurrent(second), true);
});

test('findSkip ignores suppressed ranges and the final quarter second', () => {
  const ranges = planRanges([sponsor(100, 140, 0.95, { id: 7 })], 600, cfg);
  assert.equal(findSkip(100, ranges, new Set()).id, 7);
  assert.equal(findSkip(100, ranges, new Set([7])), null);
  assert.equal(findSkip(139.9, ranges, new Set()), null);
  assert.equal(findSkip(99.9, ranges, new Set()), null);
  assert.equal(findSkip(NaN, ranges, new Set()), null);
});

function makeEngine(startTime = 0, overrides = {}) {
  const video = { currentTime: startTime, duration: 600, seeks: [] };
  let clock = 0;
  Object.defineProperty(video, 'time', { get: () => video.currentTime });
  const proxy = new Proxy(video, {
    set(target, key, value) {
      if (key === 'currentTime') target.seeks.push(value);
      target[key] = value;
      return true;
    }
  });
  const skips = [];
  const engine = createEngine({ getVideo: () => proxy, onSkip: (s) => skips.push(s), now: () => clock, ...overrides });
  return { engine, video: proxy, skips, tick: (ms) => { clock += ms; } };
}
const plan = (...segs) => planRanges(segs, 600, cfg);

test('engine skips a sponsor range once, to its end', () => {
  const { engine, video, skips } = makeEngine(100.2);
  engine.setPlan(plan(sponsor(100, 140, 0.95)), true);
  engine.onTimeUpdate();
  assert.deepEqual(video.seeks, [140]);
  assert.equal(skips.length, 1);
});

test('engine does not loop when the seek has not landed yet', () => {
  const { engine, video, tick } = makeEngine(100.2);
  engine.setPlan(plan(sponsor(100, 140, 0.95)), true);
  engine.onTimeUpdate();
  video.currentTime = 100.4;   // seek did not take effect
  tick(300);
  engine.onTimeUpdate();
  engine.onTimeUpdate();
  assert.equal(video.seeks.filter((t) => t === 140).length, 1);
});

test('engine never skips when auto skip is off, during uncertain ranges, or for non-sponsors', () => {
  const off = makeEngine(105);
  off.engine.setPlan(plan(sponsor(100, 140, 0.95)), false);
  off.engine.onTimeUpdate();
  assert.deepEqual(off.video.seeks, []);

  const unsure = makeEngine(105);
  unsure.engine.setPlan(plan(sponsor(100, 140, 0.72)), true);
  unsure.engine.onTimeUpdate();
  assert.deepEqual(unsure.video.seeks, []);

  const intro = makeEngine(105);
  intro.engine.setPlan(plan(sponsor(100, 140, 0.99, { category: 'intro' })), true);
  intro.engine.onTimeUpdate();
  assert.deepEqual(intro.video.seeks, []);
});

test('a manual seek into a sponsor does not create a skip loop', () => {
  const { engine, video, tick } = makeEngine(50);
  engine.setPlan(plan(sponsor(100, 140, 0.95)), true);
  tick(5000);
  engine.onSeeking();          // user starts scrubbing
  video.currentTime = 110;
  engine.onTimeUpdate();       // fires while scrubbing: must not skip
  assert.deepEqual(video.seeks, [110]);
  engine.onSeeked();           // user lands inside the sponsor
  engine.onTimeUpdate();
  engine.onTimeUpdate();
  assert.deepEqual(video.seeks, [110], 'only the user seek happened');
});

test('suppression ends once the user leaves the range, so it can skip again later', () => {
  const { engine, video, tick } = makeEngine(50);
  engine.setPlan(plan(sponsor(100, 140, 0.95)), true);
  tick(5000);
  engine.onSeeking(); video.currentTime = 110; engine.onSeeked();
  video.currentTime = 20; engine.onTimeUpdate();   // left the range
  tick(5000);
  video.currentTime = 100.5; engine.onTimeUpdate();
  assert.equal(video.seeks.at(-1), 140);
});

test('undo returns to the skip origin and does not skip again', () => {
  const { engine, video, skips, tick } = makeEngine(100.2);
  engine.setPlan(plan(sponsor(100, 140, 0.95)), true);
  engine.onTimeUpdate();               // skips to 140
  skips[0].undo();
  assert.equal(video.currentTime, 100.2);
  tick(5000);
  engine.onTimeUpdate();
  assert.equal(video.seeks.filter((t) => t === 140).length, 1);
});

test('never seeks when the duration is unknown or the target is not forward', () => {
  const unknown = makeEngine(105);
  unknown.video.duration = NaN;
  unknown.engine.setPlan(plan(sponsor(100, 140, 0.95)), true);
  unknown.engine.onTimeUpdate();
  assert.deepEqual(unknown.video.seeks, []);
});

test('never seeks during an ad', () => {
  const { engine, video } = makeEngine(105, { canSkip: () => false });
  engine.setPlan(plan(sponsor(100, 140, 0.95)), true);
  engine.onTimeUpdate();
  assert.deepEqual(video.seeks, []);
});

test('reset clears the plan so a new video starts clean', () => {
  const { engine, video } = makeEngine(105);
  engine.setPlan(plan(sponsor(100, 140, 0.95)), true);
  engine.reset();
  engine.onTimeUpdate();
  assert.deepEqual(video.seeks, []);
});
