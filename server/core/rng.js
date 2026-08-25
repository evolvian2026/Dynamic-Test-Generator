/**
 * Deterministic randomness.
 *
 * Every random decision the generator makes flows through a seeded PRNG so a
 * test can be reproduced exactly from its stored seed (spec §10), while an
 * unseeded run still produces a genuinely different test each time.
 */

/** 32-bit FNV-1a — stable across processes, unlike Math.random or hashCode. */
export function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Stable hash of (seed, value) in [0, 1). Exposed to SQLite as `seeded_hash`
 * so candidate rows can be ordered pseudo-randomly, yet reproducibly, by the
 * database engine itself.
 */
export function seededHash(seed, value) {
  return fnv1a(`${seed}::${value}`) / 0x100000000;
}

/** mulberry32 — small, fast, well-distributed PRNG. */
export function createRng(seed) {
  let state = (typeof seed === 'number' ? seed : fnv1a(String(seed ?? Date.now()))) >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle, in place, driven by the supplied RNG. */
export function shuffle(items, rng) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** Random integer in [min, max). */
export function randomInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min));
}

/** A fresh human-readable seed, used when the user did not supply one. */
export function generateSeed() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 10; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
