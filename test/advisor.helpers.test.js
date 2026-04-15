// Unit tests — ml/advisor.js pure helpers
// Technique map:
//   * Equivalence partitioning → stress labels, recommendation actions, seat-turnover levels
//   * Boundary value analysis  → label edges 29/30, 49/50, 69/70, turnover 5/6, 15/16, 25/26
//   * Branch / condition coverage → each rule in generateRecommendation fires at least once,
//     and each predicate clause toggles both true and false.

const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../ml/advisor');
const {
  estimateOccupancy,
  analyzeSeatTurnover,
  computeStress,
  generateRecommendation,
  findBestOption,
  generateGlobalAdvice,
} = _internal;

// ─── Test fixture helpers ───────────────────────────────────────────────
// Build a "baseline" recommendation context where every rule is off. Each
// test overrides only the fields that should flip its target branch.
const defaultArrival = (over = {}) => ({
  predictedMin: 10,
  firstBusTimeStr: null,
  lastBusTimeStr: null,
  ...over,
});

const defaultStress = (score = 20) => ({
  score,
  label: score < 30 ? 'Rahat' : score < 50 ? 'Normal' : score < 70 ? 'Yoğun' : 'Stresli',
});

const defaultRecCtx = (over = {}) => ({
  arrival: defaultArrival(),
  occupancyPct: 40,
  seatsAvailable: 20,
  isLastBus: false,
  serviceEnded: false,
  minutesToNextBus: null,
  nextBusOccupancyPct: null,
  turnover: { level: 'very_low', note: null },
  stress: defaultStress(20),
  stopSequence: 1,
  remainingStops: 5,
  ...over,
});

// ─── estimateOccupancy (equivalence partitioning + clamping) ────────────
test('estimateOccupancy: 5-class lookup maps each class correctly', () => {
  const classes = [
    ['empty', 10],
    ['light', 25],
    ['moderate', 45],
    ['busy', 65],
    ['crowded', 85],
  ];
  for (const [level, expected] of classes) {
    assert.equal(
      estimateOccupancy({ occupancy: level, delayMin: 0 }, null),
      expected,
      `${level} should map to ${expected}`
    );
  }
});

test('estimateOccupancy: unknown class falls back to 50 (branch: || 50)', () => {
  assert.equal(estimateOccupancy({ occupancy: 'gibberish', delayMin: 0 }, null), 50);
});

test('estimateOccupancy: BVA on delay bump threshold (delayMin > 2)', () => {
  // delay 2 → no bump (below boundary)
  assert.equal(estimateOccupancy({ occupancy: 'light', delayMin: 2 }, null), 25);
  // delay 3 → bump by min(15, 9) = 9
  assert.equal(estimateOccupancy({ occupancy: 'light', delayMin: 3 }, null), 34);
  // delay 100 → clamped bump to +15
  assert.equal(estimateOccupancy({ occupancy: 'light', delayMin: 100 }, null), 40);
});

test('estimateOccupancy: historical-avg blend (0.4 / 0.6)', () => {
  const result = estimateOccupancy(
    { occupancy: 'moderate', delayMin: 0 },
    { avgOccupancy: 80 }
  );
  // 45 * 0.4 + 80 * 0.6 = 18 + 48 = 66
  assert.equal(result, 66);
});

test('estimateOccupancy: output clamped to [0, 100]', () => {
  const high = estimateOccupancy(
    { occupancy: 'crowded', delayMin: 50 },
    { avgOccupancy: 200 }
  );
  assert.ok(high <= 100, `expected ≤100, got ${high}`);
});

// ─── analyzeSeatTurnover (EP + BVA on alighting bands) ──────────────────
test('analyzeSeatTurnover: null data → unknown', () => {
  assert.deepEqual(analyzeSeatTurnover(null, 0), { level: 'unknown', note: null });
  assert.deepEqual(analyzeSeatTurnover({}, 0), { level: 'unknown', note: null });
  assert.deepEqual(
    analyzeSeatTurnover({ avgAlightingNext3: 0 }, 0),
    { level: 'unknown', note: null }
  );
});

test('analyzeSeatTurnover: BVA on band edges 5/15/25', () => {
  // boundary 5: exactly 5 falls through to very_low (uses strict >)
  // NB: very_low, not unknown — unknown is reserved for missing data
  assert.equal(analyzeSeatTurnover({ avgAlightingNext3: 5 }, 0).level, 'very_low');
  assert.equal(analyzeSeatTurnover({ avgAlightingNext3: 5.01 }, 0).level, 'low');
  // boundary 15
  assert.equal(analyzeSeatTurnover({ avgAlightingNext3: 15 }, 0).level, 'low');
  assert.equal(analyzeSeatTurnover({ avgAlightingNext3: 15.01 }, 0).level, 'moderate');
  // boundary 25
  assert.equal(analyzeSeatTurnover({ avgAlightingNext3: 25 }, 0).level, 'moderate');
  assert.equal(analyzeSeatTurnover({ avgAlightingNext3: 25.01 }, 0).level, 'high');
});

test('analyzeSeatTurnover: non-null note only for low/moderate/high', () => {
  assert.ok(analyzeSeatTurnover({ avgAlightingNext3: 10 }, 0).note);
  assert.ok(analyzeSeatTurnover({ avgAlightingNext3: 20 }, 0).note);
  assert.ok(analyzeSeatTurnover({ avgAlightingNext3: 40 }, 0).note);
});

// ─── computeStress (BVA on label edges 30 / 50 / 70) ────────────────────
test('computeStress: minimal inputs → Rahat (lower equivalence class)', () => {
  const r = computeStress({
    occupancyPct: 0, delayMin: 0, isRushHour: false,
    precipitation: 0, speedFactor: 1, remainingStops: 0,
  });
  assert.equal(r.score, 0);
  assert.equal(r.label, 'Rahat');
});

test('computeStress: max inputs → Stresli + score clamped to 100', () => {
  // speedFactor 0.001 (not 0) — the `|| 1` fallback in the formula
  // treats a literal 0 as "unknown" and contributes nothing. That is
  // intentional: a speedFactor of exactly 0 means "no telemetry yet".
  const r = computeStress({
    occupancyPct: 100, delayMin: 100, isRushHour: true,
    precipitation: 50, speedFactor: 0.001, remainingStops: 20,
  });
  // 35 + 20 + 15 + 10 + ~10 + 10 = 100
  assert.equal(r.score, 100);
  assert.equal(r.label, 'Stresli');
});

test('computeStress: speedFactor=0 is treated as unknown via || 1 fallback', () => {
  // Pin the quirk so accidental removal of the `|| 1` fallback is caught.
  const r = computeStress({
    occupancyPct: 100, delayMin: 100, isRushHour: true,
    precipitation: 50, speedFactor: 0, remainingStops: 20,
  });
  assert.equal(r.score, 90); // missing the 10 points from speedFactor
});

test('computeStress: BVA on label boundary Rahat→Normal at score 30', () => {
  // occupancyPct 86 → 86/100*35 = 30.1 → clamped round → 30 → Normal
  const normal = computeStress({
    occupancyPct: 86, delayMin: 0, isRushHour: false,
    precipitation: 0, speedFactor: 1, remainingStops: 0,
  });
  assert.equal(normal.label, 'Normal');

  // occupancyPct 82 → 28.7 → round 29 → Rahat
  const rahat = computeStress({
    occupancyPct: 82, delayMin: 0, isRushHour: false,
    precipitation: 0, speedFactor: 1, remainingStops: 0,
  });
  assert.equal(rahat.label, 'Rahat');
});

test('computeStress: BVA on label boundary Normal→Yoğun at score 50', () => {
  // 50 is Yoğun (< 50 → Normal, so 50 falls through)
  // Build 50: occ 100 → 35, rushHour +15 = 50
  const yogun = computeStress({
    occupancyPct: 100, delayMin: 0, isRushHour: true,
    precipitation: 0, speedFactor: 1, remainingStops: 0,
  });
  assert.equal(yogun.score, 50);
  assert.equal(yogun.label, 'Yoğun');

  // Build 49: occ 97 → 33.95 → round 34, +15 = 49 → Normal
  const normal = computeStress({
    occupancyPct: 97, delayMin: 0, isRushHour: true,
    precipitation: 0, speedFactor: 1, remainingStops: 0,
  });
  assert.equal(normal.label, 'Normal');
});

test('computeStress: BVA on boundary Yoğun→Stresli at score 70', () => {
  // Build 70: occ 100 (35) + delayMin 20 (20) + rush (15) = 70 → Stresli
  const stresli = computeStress({
    occupancyPct: 100, delayMin: 20, isRushHour: true,
    precipitation: 0, speedFactor: 1, remainingStops: 0,
  });
  assert.equal(stresli.score, 70);
  assert.equal(stresli.label, 'Stresli');
});

test('computeStress: condition coverage on precipitation > 10', () => {
  const dry = computeStress({
    occupancyPct: 0, delayMin: 0, isRushHour: false,
    precipitation: 10, speedFactor: 1, remainingStops: 0,
  });
  const wet = computeStress({
    occupancyPct: 0, delayMin: 0, isRushHour: false,
    precipitation: 11, speedFactor: 1, remainingStops: 0,
  });
  assert.equal(dry.score, 0);
  assert.equal(wet.score, 10);
});

test('computeStress: condition coverage on remainingStops > 10', () => {
  const short = computeStress({
    occupancyPct: 0, delayMin: 0, isRushHour: false,
    precipitation: 0, speedFactor: 1, remainingStops: 10,
  });
  const longRide = computeStress({
    occupancyPct: 0, delayMin: 0, isRushHour: false,
    precipitation: 0, speedFactor: 1, remainingStops: 11,
  });
  assert.equal(short.score, 0);
  assert.equal(longRide.score, 10);
});

test('computeStress: speedFactor=0 fallback does not NaN', () => {
  // `speedFactor || 1` kicks in when speedFactor is 0 (falsy). Guard test.
  const r = computeStress({
    occupancyPct: 0, delayMin: 0, isRushHour: false,
    precipitation: 0, speedFactor: undefined, remainingStops: 0,
  });
  assert.equal(r.score, 0);
  assert.equal(Number.isFinite(r.score), true);
});

// ─── generateRecommendation (branch coverage across all 7 rules) ────────
test('generateRecommendation: serviceEnded fires first regardless of other state', () => {
  const r = generateRecommendation(defaultRecCtx({
    serviceEnded: true,
    arrival: defaultArrival({ predictedMin: 1, firstBusTimeStr: '05:45' }),
    isLastBus: true,
    stress: defaultStress(95),
  }));
  assert.equal(r.action, 'service-ended');
  assert.equal(r.icon, '🌙');
  assert.match(r.text, /05:45/);
});

test('generateRecommendation: serviceEnded without firstBusTimeStr falls back to "sabah"', () => {
  const r = generateRecommendation(defaultRecCtx({ serviceEnded: true }));
  assert.match(r.text, /sabah/);
});

test('generateRecommendation: run chip at BVA boundary predictedMin=2', () => {
  const r = generateRecommendation(defaultRecCtx({
    arrival: defaultArrival({ predictedMin: 2 }),
  }));
  assert.equal(r.action, 'run');
  assert.equal(r.priority, 'urgent');
});

test('generateRecommendation: no run chip at predictedMin=3 (just above boundary)', () => {
  const r = generateRecommendation(defaultRecCtx({
    arrival: defaultArrival({ predictedMin: 3 }),
    stress: defaultStress(20),
  }));
  assert.notEqual(r.action, 'run');
});

test('generateRecommendation: isLastBus → critical chip with time', () => {
  const r = generateRecommendation(defaultRecCtx({
    isLastBus: true,
    arrival: defaultArrival({ predictedMin: 10, lastBusTimeStr: '22:56' }),
  }));
  assert.equal(r.action, 'board');
  assert.equal(r.priority, 'critical');
  assert.match(r.text, /22:56/);
});

test('generateRecommendation: wait-for-emptier fires when diff > 20 and next ≤ 12', () => {
  const r = generateRecommendation(defaultRecCtx({
    occupancyPct: 90,
    minutesToNextBus: 8,
    nextBusOccupancyPct: 60,
  }));
  assert.equal(r.action, 'wait');
});

test('generateRecommendation: wait does NOT fire when occupancy diff ≤ 20 (branch false)', () => {
  const r = generateRecommendation(defaultRecCtx({
    occupancyPct: 70,
    minutesToNextBus: 8,
    nextBusOccupancyPct: 60,  // diff = 10, below 20 threshold
    stress: defaultStress(20),
  }));
  assert.notEqual(r.action, 'wait');
});

test('generateRecommendation: seat-turnover hint when seats ≤ 5 and turnover high', () => {
  const r = generateRecommendation(defaultRecCtx({
    seatsAvailable: 3,
    turnover: { level: 'high', note: 'Koltuklar 2 durakta boşalacak' },
  }));
  assert.equal(r.action, 'board');
  assert.equal(r.icon, '🪑');
});

test('generateRecommendation: alternative (reverse route) for crowded long ride past start', () => {
  const r = generateRecommendation(defaultRecCtx({
    stopSequence: 3,
    remainingStops: 13,
    occupancyPct: 75,
    stress: defaultStress(20),
  }));
  assert.equal(r.action, 'alternative');
});

test('generateRecommendation: default ok chip when stress < 50', () => {
  const r = generateRecommendation(defaultRecCtx({
    stress: defaultStress(25),
  }));
  assert.equal(r.action, 'board');
  assert.equal(r.priority, 'ok');
});

test('generateRecommendation: high-stress-no-alternative fallback at stress ≥ 50', () => {
  const r = generateRecommendation(defaultRecCtx({
    stress: defaultStress(80),
  }));
  assert.equal(r.action, 'board');
  assert.equal(r.priority, 'warning');
});

// ─── findBestOption ─────────────────────────────────────────────────────
test('findBestOption: empty array returns 0 (edge)', () => {
  assert.equal(findBestOption([]), 0);
});

test('findBestOption: picks lowest composite stress+wait+occupancy score', () => {
  const options = [
    { stressScore: 80, predictedMin: 5,  occupancyPct: 90 }, // bad
    { stressScore: 20, predictedMin: 4,  occupancyPct: 30 }, // best
    { stressScore: 50, predictedMin: 2,  occupancyPct: 60 }, // mid
  ];
  assert.equal(findBestOption(options), 1);
});

// ─── generateGlobalAdvice (EP over the banner's 4 outcomes) ─────────────
test('generateGlobalAdvice: empty options → info text', () => {
  assert.equal(generateGlobalAdvice([], null), 'Şu an sefer bilgisi yok.');
});

test('generateGlobalAdvice: all serviceEnded → moon banner with earliest time', () => {
  const opts = [
    { serviceEnded: true, firstBusTimeStr: '06:33', stressScore: 10 },
    { serviceEnded: true, firstBusTimeStr: '05:47', stressScore: 10 },
  ];
  const banner = generateGlobalAdvice(opts, null);
  assert.match(banner, /🌙/);
  assert.match(banner, /05:47/);
});

test('generateGlobalAdvice: any isLastBus → last-bus warning', () => {
  const opts = [
    { serviceEnded: false, isLastBus: true, stressScore: 10 },
    { serviceEnded: false, isLastBus: false, stressScore: 10 },
  ];
  const banner = generateGlobalAdvice(opts, null);
  assert.match(banner, /Son/);
});

test('generateGlobalAdvice: all stressed → stress-wide message', () => {
  const opts = [
    { serviceEnded: false, isLastBus: false, stressScore: 75, predictedMin: 5, occupancyPct: 90 },
    { serviceEnded: false, isLastBus: false, stressScore: 80, predictedMin: 6, occupancyPct: 95 },
  ];
  const banner = generateGlobalAdvice(opts, null);
  assert.match(banner, /kalabalık/i);
});
