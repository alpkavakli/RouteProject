// Unit tests — ml/predictor.js pure helpers
// Technique map:
//   * Equivalence partitioning   → 5 occupancy classes
//   * Boundary value analysis    → class edges 15/35/60/80, minute edges
//   * Statement + branch coverage on timeToMinutes' null / string / object branches

const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../ml/predictor');
const { timeToMinutes, classifyOccupancyPct, formatTimeHHMM, SERVICE_GAP_MIN } = _internal;

// ─── timeToMinutes ──────────────────────────────────────────────────────
test('timeToMinutes: null and undefined return 0 (branch: early-return)', () => {
  assert.equal(timeToMinutes(null), 0);
  assert.equal(timeToMinutes(undefined), 0);
});

test('timeToMinutes: plain HH:MM:SS string (branch: typeof string)', () => {
  assert.equal(timeToMinutes('00:00:00'), 0);
  assert.equal(timeToMinutes('01:30:00'), 90);
  assert.equal(timeToMinutes('23:59:00'), 23 * 60 + 59);
});

test('timeToMinutes: seconds contribute fractional minutes', () => {
  assert.equal(timeToMinutes('00:00:30'), 0.5);
  assert.equal(timeToMinutes('00:01:30'), 1.5);
});

test('timeToMinutes: TIME values beyond 24:00 are honored (MySQL quirk)', () => {
  // MySQL TIME supports >24h values. Hackathon CSVs use this for late trips.
  assert.equal(timeToMinutes('25:33:00'), 25 * 60 + 33);
});

test('timeToMinutes: object with toString (branch: else)', () => {
  const fake = { toString: () => '02:15:00' };
  assert.equal(timeToMinutes(fake), 135);
});

// ─── classifyOccupancyPct ───────────────────────────────────────────────
// Boundary value analysis: edges 15, 35, 60, 80
// Representatives + each edge tested at edge and edge-1
test('classifyOccupancyPct: empty partition (pct < 15)', () => {
  assert.equal(classifyOccupancyPct(0), 'empty');
  assert.equal(classifyOccupancyPct(14), 'empty');
  assert.equal(classifyOccupancyPct(14.99), 'empty');
});

test('classifyOccupancyPct: light partition (15 ≤ pct < 35)', () => {
  assert.equal(classifyOccupancyPct(15), 'light');   // lower edge
  assert.equal(classifyOccupancyPct(25), 'light');   // representative
  assert.equal(classifyOccupancyPct(34), 'light');
  assert.equal(classifyOccupancyPct(34.99), 'light'); // off-by-one above
});

test('classifyOccupancyPct: moderate partition (35 ≤ pct < 60)', () => {
  assert.equal(classifyOccupancyPct(35), 'moderate');
  assert.equal(classifyOccupancyPct(50), 'moderate');
  assert.equal(classifyOccupancyPct(59.99), 'moderate');
});

test('classifyOccupancyPct: busy partition (60 ≤ pct < 80)', () => {
  assert.equal(classifyOccupancyPct(60), 'busy');
  assert.equal(classifyOccupancyPct(70), 'busy');
  assert.equal(classifyOccupancyPct(79.99), 'busy');
});

test('classifyOccupancyPct: crowded partition (pct ≥ 80)', () => {
  assert.equal(classifyOccupancyPct(80), 'crowded');
  assert.equal(classifyOccupancyPct(100), 'crowded');
  assert.equal(classifyOccupancyPct(150), 'crowded'); // invalid-high, still crowded
});

// ─── formatTimeHHMM ─────────────────────────────────────────────────────
test('formatTimeHHMM: null/undefined return null (branch: early-return)', () => {
  assert.equal(formatTimeHHMM(null), null);
  assert.equal(formatTimeHHMM(undefined), null);
});

test('formatTimeHHMM: pads single-digit components to two digits', () => {
  assert.equal(formatTimeHHMM('5:45:00'), '05:45');
  assert.equal(formatTimeHHMM('05:5:00'), '05:05');
});

test('formatTimeHHMM: strips seconds', () => {
  assert.equal(formatTimeHHMM('23:59:59'), '23:59');
});

test('formatTimeHHMM: malformed string (no colon) returns null', () => {
  assert.equal(formatTimeHHMM('nonsense'), null);
});

// ─── SERVICE_GAP_MIN threshold ──────────────────────────────────────────
// Not a function, but a named constant — the boundary value for
// "service has ended" detection. Worth pinning so accidental edits
// to the constant are caught by the suite.
test('SERVICE_GAP_MIN is the 3-hour night-gap threshold', () => {
  assert.equal(SERVICE_GAP_MIN, 180);
});
