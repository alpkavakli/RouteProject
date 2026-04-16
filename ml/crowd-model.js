// ─── Crowd Estimation Model ─────────────────────────────────────────────
// Random Forest Classifier for predicting stop crowd level
// Supports both 3-class (synthetic) and 5-class (hackathon real data)

const fs = require('fs');
const path = require('path');
const { RandomForestClassifier } = require('ml-random-forest');
const { generateCrowdDataset } = require('./data-generator');

const CACHE_DIR = path.join(__dirname, 'cache');
const MODEL_PATH = path.join(CACHE_DIR, 'crowd-model.json');
const METRICS_PATH = path.join(CACHE_DIR, 'crowd-metrics.json');

const FEATURE_NAMES = [
  'hour', 'dayOfWeek', 'isRushHour', 'temperature', 'precipitation',
  'windSpeed', 'currentDelay', 'routeFrequency', 'stopPopularity',
];

// 5-class labels (hackathon data)
const LABELS_5 = ['empty', 'light', 'moderate', 'busy', 'crowded'];
// 3-class labels (synthetic fallback)
const LABELS_3 = ['low', 'medium', 'high'];

let model = null;
let trainMetrics = null;
let activeLabels = LABELS_3; // default to 3-class, updated on training

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
    model = RandomForestClassifier.load(modelJson);
    trainMetrics = metricsJson;
    activeLabels = metricsJson.numClasses === 5 ? LABELS_5 : LABELS_3;
    console.log(`   ✅ Crowd model loaded from cache — Accuracy: ${trainMetrics.accuracy}% (${activeLabels.length}-class)`);
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
  console.log('   Training crowd estimation model (3-class synthetic)...');
  const start = Date.now();

  const { X: trainX, y: trainY } = generateCrowdDataset(2000);
  const { X: testX, y: testY } = generateCrowdDataset(400);
  activeLabels = LABELS_3;

  model = new RandomForestClassifier({
    nEstimators: 40,
    maxFeatures: 0.7,
    replacement: true,
    seed: 42,
    useSampleBagging: true,
  });

  model.train(trainX, trainY);

  const predictions = model.predict(testX);
  let correct = 0;
  const numClasses = 3;
  const confusion = Array.from({ length: numClasses }, () => Array(numClasses).fill(0));

  for (let i = 0; i < testY.length; i++) {
    if (predictions[i] === testY[i]) correct++;
    confusion[testY[i]][predictions[i]]++;
  }

  const accuracy = (correct / testY.length) * 100;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  const classMetrics = activeLabels.map((label, idx) => {
    const tp = confusion[idx][idx];
    const fp = confusion.reduce((sum, row, r) => sum + (r !== idx ? row[idx] : 0), 0);
    const fn = confusion[idx].reduce((sum, val, c) => sum + (c !== idx ? val : 0), 0);
    const precision = tp + fp > 0 ? ((tp / (tp + fp)) * 100).toFixed(1) : '0.0';
    const recall = tp + fn > 0 ? ((tp / (tp + fn)) * 100).toFixed(1) : '0.0';
    return { label, precision: parseFloat(precision), recall: parseFloat(recall) };
  });

  trainMetrics = {
    accuracy: parseFloat(accuracy.toFixed(1)),
    classMetrics,
    trainSamples: trainX.length,
    testSamples: testX.length,
    nEstimators: 40,
    trainingTime: `${elapsed}s`,
    numClasses: 3,
  };

  console.log(`   ✅ Crowd model trained in ${elapsed}s — Accuracy: ${trainMetrics.accuracy}%`);
}

/**
 * Train on real 5-class hackathon data
 */
function trainFromRealData(dataset) {
  console.log(`   Training crowd model on ${dataset.total} real flow records (5-class)...`);
  const start = Date.now();
  activeLabels = LABELS_5;

  // Clear cache
  try { if (fs.existsSync(MODEL_PATH)) fs.unlinkSync(MODEL_PATH); } catch (e) {}
  try { if (fs.existsSync(METRICS_PATH)) fs.unlinkSync(METRICS_PATH); } catch (e) {}

  model = new RandomForestClassifier({
    nEstimators: 50,
    maxFeatures: 0.7,
    replacement: true,
    seed: 42,
    useSampleBagging: true,
  });

  model.train(dataset.train.X, dataset.train.y);

  const predictions = model.predict(dataset.test.X);
  let correct = 0;
  const numClasses = 5;
  const confusion = Array.from({ length: numClasses }, () => Array(numClasses).fill(0));

  for (let i = 0; i < dataset.test.y.length; i++) {
    if (predictions[i] === dataset.test.y[i]) correct++;
    if (dataset.test.y[i] < numClasses && predictions[i] < numClasses) {
      confusion[dataset.test.y[i]][predictions[i]]++;
    }
  }

  const accuracy = (correct / dataset.test.y.length) * 100;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  const classMetrics = activeLabels.map((label, idx) => {
    const tp = confusion[idx][idx];
    const fp = confusion.reduce((sum, row, r) => sum + (r !== idx ? row[idx] : 0), 0);
    const fn = confusion[idx].reduce((sum, val, c) => sum + (c !== idx ? val : 0), 0);
    const precision = tp + fp > 0 ? ((tp / (tp + fp)) * 100).toFixed(1) : '0.0';
    const recall = tp + fn > 0 ? ((tp / (tp + fn)) * 100).toFixed(1) : '0.0';
    return { label, precision: parseFloat(precision), recall: parseFloat(recall) };
  });

  trainMetrics = {
    accuracy: parseFloat(accuracy.toFixed(1)),
    classMetrics,
    trainSamples: dataset.train.X.length,
    testSamples: dataset.test.X.length,
    nEstimators: 50,
    trainingTime: `${elapsed}s`,
    numClasses: 5,
    dataSource: 'hackathon_real',
  };

  saveToCache();
  console.log(`   ✅ Crowd model trained on REAL data in ${elapsed}s — Accuracy: ${trainMetrics.accuracy}% (5-class)`);
}

/**
 * Predict crowd level for given conditions
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
    (conditions.currentDelay || 0) / 10,
    (conditions.routeFrequency || 8) / 15,
    conditions.stopPopularity || 0.5,
  ];

  // Single pass through all trees — vote + probabilities together
  // (was: model.predict traversed all trees, then we iterated estimators again)
  const treePredictions = model.estimators.map(tree => tree.predict([features])[0]);
  const votes = Array(activeLabels.length).fill(0);
  treePredictions.forEach(p => { if (p < votes.length) votes[p]++; });

  // Majority vote = prediction
  const prediction = votes.indexOf(Math.max(...votes));
  const level = activeLabels[prediction] || activeLabels[0];
  const total = treePredictions.length;
  const probabilities = votes.map(v => parseFloat(((v / total) * 100).toFixed(1)));

  const confidence = Math.round(probabilities[prediction] || 50);

  // Estimated count based on level
  const countRanges = {
    empty: [0, 3], light: [3, 12], moderate: [12, 28], busy: [28, 45], crowded: [45, 80],
    low: [2, 10], medium: [12, 28], high: [30, 55],
  };
  const range = countRanges[level] || [5, 20];
  const estimatedCount = Math.round(range[0] + (range[1] - range[0]) * (confidence / 100));

  // Generate reason
  const reason = generateReason(conditions, level);

  // Trend based on time
  const hour = conditions.hour || 12;
  let trend = 'stable';
  if (hour >= 6 && hour <= 8) trend = 'rising';
  else if (hour >= 9 && hour <= 11) trend = 'falling';
  else if (hour >= 16 && hour <= 17) trend = 'rising';
  else if (hour >= 19 && hour <= 21) trend = 'falling';

  // Build probability object
  const probObj = {};
  activeLabels.forEach((label, i) => { probObj[label] = probabilities[i]; });

  return {
    level,
    estimatedCount,
    confidence,
    probabilities: probObj,
    reason,
    trend,
  };
}

function generateReason(cond, level) {
  const parts = [];

  if (cond.isRushHour) parts.push('rush hour congestion');
  if (cond.precipitation > 15) parts.push('rain increasing transit demand');
  if (cond.currentDelay > 3) parts.push('bus delays causing passenger accumulation');
  if (cond.stopPopularity > 0.8) parts.push('high-demand stop');

  if (parts.length === 0) {
    const reasons = {
      empty: 'very low passenger activity',
      light: 'low passenger volume, off-peak',
      low: 'off-peak period, favorable conditions',
      moderate: 'moderate passenger demand',
      medium: 'moderate passenger demand',
      busy: 'above average passenger volume',
      high: 'multiple congestion factors',
      crowded: 'very high passenger concentration',
    };
    parts.push(reasons[level] || 'typical conditions');
  }

  return parts.join(', ').replace(/^./, c => c.toUpperCase());
}

function getMetrics() {
  return trainMetrics;
}

function getLabels() {
  return activeLabels;
}

module.exports = { train, predict, getMetrics, trainFromRealData, getLabels, LABELS_5, LABELS_3 };
