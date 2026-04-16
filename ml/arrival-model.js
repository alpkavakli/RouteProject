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
  'recentDelay', 'segmentIndex',
];

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
  ];

  // Single pass through all trees — compute prediction + confidence together
  // (was: model.predict traversed all trees, then we iterated estimators again)
  const treePredictions = model.estimators.map(tree => tree.predict([features])[0]);
  const sum = treePredictions.reduce((a, b) => a + b, 0);
  const predictedDelay = sum / treePredictions.length;

  // Confidence: inverse of prediction variance across trees
  const variance = treePredictions.reduce((a, b) => a + (b - predictedDelay) ** 2, 0) / treePredictions.length;
  const stddev = Math.sqrt(variance);
  const confidence = Math.max(60, Math.min(98, Math.round(100 - stddev * 12)));

  // Generate interpretable factors
  const factors = generateFactors(conditions, predictedDelay);

  return {
    predictedDelay: parseFloat(predictedDelay.toFixed(1)),
    confidence,
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

/**
 * Train on real hackathon data (pre-split dataset)
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
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  trainMetrics = {
    mae: parseFloat(mae.toFixed(2)),
    within1Min: parseFloat(((within1 / dataset.test.y.length) * 100).toFixed(1)),
    within2Min: parseFloat(((within2 / dataset.test.y.length) * 100).toFixed(1)),
    trainSamples: dataset.train.X.length,
    testSamples: dataset.test.X.length,
    nEstimators: 50,
    trainingTime: `${elapsed}s`,
    dataSource: 'hackathon_real',
  };

  saveToCache();
  console.log(`   ✅ Arrival model trained on REAL data in ${elapsed}s — MAE: ${trainMetrics.mae} min, within 2 min: ${trainMetrics.within2Min}%`);
}

module.exports = { train, predict, getMetrics, trainFromRealData };

