// ─── Arrival Time Prediction Model ──────────────────────────────────────
// Random Forest Regressor for predicting bus delay (minutes)

const fs = require('fs');
const path = require('path');
const { RandomForestRegression } = require('ml-random-forest');
const { generateArrivalDataset } = require('./data-generator');

const CACHE_DIR = path.join(__dirname, 'cache');
const MODEL_PATH = path.join(CACHE_DIR, 'arrival-model.json');
const METRICS_PATH = path.join(CACHE_DIR, 'arrival-metrics.json');

const FEATURE_NAMES = [
  'hour', 'dayOfWeek', 'isRushHour', 'temperature', 'precipitation',
  'windSpeed', 'scheduledMinutes', 'stopPopularity', 'routeAvgDelay',
  'recentDelay', 'segmentIndex', 'prevStopDelay',
];

// Bumped when the feature set changes so stale on-disk models are discarded.
const FEATURE_VERSION = 3;

// Fallback multiplier when a cached model lacks a calibrated conformal
// value — matches the Gaussian 80% CI we shipped originally.
const DEFAULT_CONFORMAL_MULTIPLIER_80 = 1.28;

let model = null;
let trainMetrics = null;

/**
 * Try to load cached model, otherwise train from scratch
 */
function train() {
  if (loadFromCache()) return;
  trainFresh();
  saveToCache();
}

function loadFromCache() {
  try {
    if (!fs.existsSync(MODEL_PATH) || !fs.existsSync(METRICS_PATH)) return false;
    const modelJson = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
    const metricsJson = JSON.parse(fs.readFileSync(METRICS_PATH, 'utf8'));
    if (metricsJson.featureVersion !== FEATURE_VERSION) {
      console.log(`   ⚠️ Cached model is featureVersion ${metricsJson.featureVersion} but code is v${FEATURE_VERSION} — retraining.`);
      return false;
    }
    model = RandomForestRegression.load(modelJson);
    trainMetrics = metricsJson;
    console.log(`   ✅ Arrival model loaded from cache — MAE: ${trainMetrics.mae} min`);
    return true;
  } catch (err) {
    console.log(`   ⚠️ Cache load failed: ${err.message}, retraining...`);
    return false;
  }
}

function saveToCache() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(MODEL_PATH, JSON.stringify(model.toJSON()));
    fs.writeFileSync(METRICS_PATH, JSON.stringify(trainMetrics));
  } catch (err) {
    console.log(`   ⚠️ Cache save failed: ${err.message}`);
  }
}

function trainFresh() {
  console.log('   Training arrival prediction model...');
  const start = Date.now();

  const { X: trainX, y: trainY } = generateArrivalDataset(3000);
  const { X: testX, y: testY } = generateArrivalDataset(500);

  model = new RandomForestRegression({
    nEstimators: 50,
    maxFeatures: 0.7,
    replacement: true,
    seed: 42,
    useSampleBagging: true,
  });

  model.train(trainX, trainY);

  const predictions = model.predict(testX);
  let totalError = 0;
  let within1 = 0;
  let within2 = 0;

  for (let i = 0; i < testY.length; i++) {
    const error = Math.abs(predictions[i] - testY[i]);
    totalError += error;
    if (error <= 1) within1++;
    if (error <= 2) within2++;
  }

  const mae = totalError / testY.length;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  trainMetrics = {
    mae: parseFloat(mae.toFixed(2)),
    within1Min: parseFloat(((within1 / testY.length) * 100).toFixed(1)),
    within2Min: parseFloat(((within2 / testY.length) * 100).toFixed(1)),
    trainSamples: trainX.length,
    testSamples: testX.length,
    nEstimators: 50,
    trainingTime: `${elapsed}s`,
    featureVersion: FEATURE_VERSION,
    features: FEATURE_NAMES,
    conformal: {
      multiplier80: DEFAULT_CONFORMAL_MULTIPLIER_80,
      multiplier95: DEFAULT_CONFORMAL_MULTIPLIER_80 * (1.96 / 1.28),
      testCoverage80: null,
      testCoverage95: null,
    },
  };

  console.log(`   ✅ Arrival model trained in ${elapsed}s — MAE: ${trainMetrics.mae} min, within 2 min: ${trainMetrics.within2Min}%`);
}

/**
 * Predict delay for given conditions
 * @param {Object} conditions - { hour, dayOfWeek, isRushHour, temperature, precipitation, windSpeed, scheduledMinutes, stopPopularity, routeAvgDelay, recentDelay, segmentIndex }
 * @returns {{ predictedDelay, confidence, factors }}
 */
function predict(conditions) {
  if (!model) throw new Error('Model not trained');

  const features = [
    (conditions.hour || 12) / 23,
    (conditions.dayOfWeek || 3) / 6,
    conditions.isRushHour ? 1 : 0,
    (conditions.temperature || 20) / 40,
    (conditions.precipitation || 0) / 80,
    (conditions.windSpeed || 10) / 45,
    (conditions.scheduledMinutes || 10) / 30,
    conditions.stopPopularity || 0.5,
    (conditions.routeAvgDelay || 2) / 4,
    (conditions.recentDelay || 0) / 8,
    (conditions.segmentIndex || 5) / 10,
    // Delay observed at the same trip's previous stop. When missing (first stop
    // or no per-stop sample), fall back to recentDelay so the signal degrades
    // to what the old model saw instead of injecting a misleading zero.
    (conditions.prevStopDelay != null ? conditions.prevStopDelay : (conditions.recentDelay || 0)) / 10,
  ];

  // Single pass through all trees — compute prediction + confidence together
  // (was: model.predict traversed all trees, then we iterated estimators again)
  const treePredictions = model.estimators.map(tree => tree.predict([features])[0]);
  const sum = treePredictions.reduce((a, b) => a + b, 0);
  const predictedDelay = sum / treePredictions.length;

  // Confidence: inverse of prediction variance across trees
  const variance = treePredictions.reduce((a, b) => a + (b - predictedDelay) ** 2, 0) / treePredictions.length;
  const stddevRaw = Math.sqrt(variance);
  const stddev = Math.max(0.4, stddevRaw);
  const confidence = Math.max(60, Math.min(98, Math.round(100 - stddevRaw * 12)));

  // Conformal ± band. Multiplier is the value calibrated on the held-out
  // cal set during training (80% coverage target). When no calibration is
  // available (synthetic fallback, stale cache), we default to 1.28 which
  // is the Gaussian 80% CI multiplier the model shipped with originally.
  const conformal = trainMetrics && trainMetrics.conformal;
  const mult80 = (conformal && conformal.multiplier80) || DEFAULT_CONFORMAL_MULTIPLIER_80;
  const bandMin = Math.max(1, Math.round(stddev * mult80));

  // Generate interpretable factors
  const factors = generateFactors(conditions, predictedDelay);

  return {
    predictedDelay: parseFloat(predictedDelay.toFixed(1)),
    confidence,
    // Std-dev across the forest's per-tree predictions (floored at 0.4).
    stddev: parseFloat(stddev.toFixed(2)),
    // Split-conformal ± minutes band. Prefer this over ad-hoc stddev×1.28.
    bandMin,
    factors,
  };
}

/**
 * Generate human-readable explanation factors
 */
function generateFactors(cond, delay) {
  const factors = [];

  if (cond.isRushHour) {
    factors.push({ icon: '🕐', label: 'Rush hour', impact: '+2-5 min', type: 'negative' });
  }
  if (cond.precipitation > 15) {
    factors.push({ icon: '🌧️', label: 'Rain', impact: `+${Math.min(4, cond.precipitation / 20).toFixed(0)}-${Math.min(6, cond.precipitation / 12).toFixed(0)} min`, type: 'negative' });
  }
  if (cond.windSpeed > 20) {
    factors.push({ icon: '💨', label: 'High wind', impact: '+1-2 min', type: 'negative' });
  }
  if (cond.recentDelay > 2) {
    factors.push({ icon: '⏱️', label: 'Recent delays', impact: `+${(cond.recentDelay * 0.5).toFixed(0)} min`, type: 'negative' });
  }
  if (cond.temperature < 0) {
    factors.push({ icon: '❄️', label: 'Icy conditions', impact: '+1 min', type: 'negative' });
  }
  if (!cond.isRushHour && cond.precipitation <= 5 && cond.windSpeed <= 15) {
    factors.push({ icon: '✅', label: 'Good conditions', impact: 'Minimal delay', type: 'positive' });
  }
  if (cond.stopPopularity > 0.8) {
    factors.push({ icon: '📍', label: 'Busy stop area', impact: '+1-2 min', type: 'neutral' });
  }

  return factors;
}

function getMetrics() {
  return trainMetrics;
}

// Predict with per-tree stddev in one traversal. Used by training-time
// calibration and evaluation — inference goes through predict() instead.
function predictWithStddev(featureRow) {
  const treePreds = model.estimators.map(t => t.predict([featureRow])[0]);
  const mean = treePreds.reduce((a, b) => a + b, 0) / treePreds.length;
  const variance = treePreds.reduce((a, b) => a + (b - mean) ** 2, 0) / treePreds.length;
  return { pred: mean, stddev: Math.max(0.4, Math.sqrt(variance)) };
}

/**
 * Train on real hackathon data.
 *
 *   dataset = { train, cal?, test, total }
 *
 * Training flow:
 *   1. Fit forest on `train`
 *   2. Calibrate a split-conformal multiplier on `cal`: the smallest k such
 *      that |y − ŷ| ≤ k·stddev for ≥ TARGET% of calibration points. By
 *      exchangeability this k gives ~TARGET% coverage on fresh test points.
 *   3. Evaluate MAE and empirical conformal coverage on `test`.
 *
 * If `cal` is absent (e.g. synthetic path), we skip conformal and report
 * a 1.28 default multiplier (Gaussian 80% band).
 */
function trainFromRealData(dataset) {
  console.log(`   Training arrival model on ${dataset.total} real observations...`);
  const start = Date.now();

  // Clear cache so next load uses this model
  try { if (fs.existsSync(MODEL_PATH)) fs.unlinkSync(MODEL_PATH); } catch (e) {}
  try { if (fs.existsSync(METRICS_PATH)) fs.unlinkSync(METRICS_PATH); } catch (e) {}

  model = new RandomForestRegression({
    nEstimators: 50,
    maxFeatures: 0.7,
    replacement: true,
    seed: 42,
    useSampleBagging: true,
  });

  model.train(dataset.train.X, dataset.train.y);

  // ─── Evaluate on test: MAE + within-X-min ─────────────────────────────
  const predictions = model.predict(dataset.test.X);
  let totalError = 0;
  let within1 = 0;
  let within2 = 0;

  for (let i = 0; i < dataset.test.y.length; i++) {
    const error = Math.abs(predictions[i] - dataset.test.y[i]);
    totalError += error;
    if (error <= 1) within1++;
    if (error <= 2) within2++;
  }

  const mae = totalError / dataset.test.y.length;

  // ─── Split-conformal calibration (RF-stddev non-conformity) ───────────
  // Non-conformity score = |y − ŷ| / stddev. For target coverage α, the
  // multiplier is the ceil((n+1)·α)/n-quantile of scores on the cal set.
  let conformalMultiplier80 = DEFAULT_CONFORMAL_MULTIPLIER_80;
  let conformalMultiplier95 = DEFAULT_CONFORMAL_MULTIPLIER_80 * (1.96 / 1.28);
  let testCoverage80 = null;
  let testCoverage95 = null;
  let meanBandMin80 = null;
  let calSamples = 0;

  if (dataset.cal && dataset.cal.X.length >= 20) {
    const scores = [];
    for (let i = 0; i < dataset.cal.X.length; i++) {
      const { pred, stddev } = predictWithStddev(dataset.cal.X[i]);
      scores.push(Math.abs(dataset.cal.y[i] - pred) / stddev);
    }
    scores.sort((a, b) => a - b);
    const pick = (alpha) => {
      const n = scores.length;
      const idx = Math.min(n - 1, Math.ceil((n + 1) * alpha) - 1);
      return scores[Math.max(0, idx)];
    };
    conformalMultiplier80 = pick(0.80);
    conformalMultiplier95 = pick(0.95);
    calSamples = scores.length;

    // Empirical coverage on held-out test set — the honest generalization
    // check. Under exchangeability these should be ≈ 0.80 and 0.95.
    let cov80 = 0, cov95 = 0, sumBand80 = 0;
    for (let i = 0; i < dataset.test.X.length; i++) {
      const { pred, stddev } = predictWithStddev(dataset.test.X[i]);
      const residual = Math.abs(dataset.test.y[i] - pred);
      if (residual <= stddev * conformalMultiplier80) cov80++;
      if (residual <= stddev * conformalMultiplier95) cov95++;
      sumBand80 += stddev * conformalMultiplier80;
    }
    testCoverage80 = cov80 / dataset.test.X.length;
    testCoverage95 = cov95 / dataset.test.X.length;
    meanBandMin80 = sumBand80 / dataset.test.X.length;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  trainMetrics = {
    mae: parseFloat(mae.toFixed(2)),
    within1Min: parseFloat(((within1 / dataset.test.y.length) * 100).toFixed(1)),
    within2Min: parseFloat(((within2 / dataset.test.y.length) * 100).toFixed(1)),
    trainSamples: dataset.train.X.length,
    calSamples,
    testSamples: dataset.test.X.length,
    nEstimators: 50,
    trainingTime: `${elapsed}s`,
    dataSource: 'hackathon_real',
    featureVersion: FEATURE_VERSION,
    features: FEATURE_NAMES,
    splitStrategy: dataset.splitStrategy || 'unknown',
    conformal: {
      multiplier80: parseFloat(conformalMultiplier80.toFixed(3)),
      multiplier95: parseFloat(conformalMultiplier95.toFixed(3)),
      testCoverage80: testCoverage80 != null ? parseFloat((testCoverage80 * 100).toFixed(1)) : null,
      testCoverage95: testCoverage95 != null ? parseFloat((testCoverage95 * 100).toFixed(1)) : null,
      meanBandMin80: meanBandMin80 != null ? parseFloat(meanBandMin80.toFixed(2)) : null,
    },
  };

  saveToCache();
  const covStr = testCoverage80 != null
    ? `, conformal 80% coverage ${(testCoverage80 * 100).toFixed(1)}% (multiplier ${conformalMultiplier80.toFixed(2)}·σ)`
    : '';
  console.log(`   ✅ Arrival model trained on REAL data in ${elapsed}s — MAE: ${trainMetrics.mae} min, within 2 min: ${trainMetrics.within2Min}%${covStr}`);
}

module.exports = { train, predict, getMetrics, trainFromRealData };

