// Central configuration. Every tunable number lives here; nothing else hard-codes thresholds.
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    autoSkip: true,
    sponsorSkipThreshold: 0.84,
    uncertainThreshold: 0.6,
    targetSegmentSeconds: 30,
    minimumSkipSeconds: 4,
    maximumSkipSeconds: 180,
    mergeGapSeconds: 2,
    showTimeline: true,
    debug: false,
    endpoint: 'https://api.anthropic.com'
  });

  // [min, max] accepted for each numeric setting.
  const BOUNDS = Object.freeze({
    sponsorSkipThreshold: [0.5, 0.99],
    uncertainThreshold: [0.3, 0.95],
    targetSegmentSeconds: [15, 60],
    minimumSkipSeconds: [1, 30],
    maximumSkipSeconds: [30, 600],
    mergeGapSeconds: [0, 10]
  });

  const LABELS = Object.freeze([
    'content', 'sponsor', 'intro', 'outro', 'self_promo', 'interaction', 'recap', 'other'
  ]);

  // SponsorBlock category -> our label.
  const SPONSORBLOCK_CATEGORIES = Object.freeze({
    sponsor: 'sponsor',
    selfpromo: 'self_promo',
    intro: 'intro',
    outro: 'outro',
    interaction: 'interaction'
  });

  const STATE = Object.freeze({ SAFE: 'safe', UNCERTAIN: 'uncertain', SKIP: 'skip' });

  const HOUR = 60 * 60 * 1000;
  const CACHE_TTL_MS = Object.freeze({ ai: 7 * 24 * HOUR, sponsorblock: 6 * HOUR });

  const LIMITS = Object.freeze({
    maxSegmentsPerRequest: 240,
    maxSegmentChars: 1500,
    maxTextChars: 200,
    maxUrlLength: 2048,
    maxCacheEntries: 300,
    captionWaitMs: 10000,
    enableCaptionsAfterMs: 3000,
    requestTimeoutMs: 60000
  });

  const MODEL = 'claude-haiku-4-5-20251001';
  const SCHEMA_VERSION = 1;
  const CACHE_PREFIX = 'cache:';

  const api = {
    DEFAULTS, BOUNDS, LABELS, SPONSORBLOCK_CATEGORIES, STATE, CACHE_TTL_MS,
    LIMITS, MODEL, SCHEMA_VERSION, CACHE_PREFIX
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root.Skipper = root.Skipper || {}, api);
})(typeof self !== 'undefined' ? self : globalThis);
