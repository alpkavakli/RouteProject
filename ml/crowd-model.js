// ─── Crowd Estimation Model ─────────────────────────────────────────────
// Random Forest Classifier for predicting stop crowd level (low/medium/high)

const { RandomForestClassifier } = require('ml-random-forest');
const { generateCrowdDataset } = require('./data-generator');

const FEATURE_NAMES = [
  'hour', 'dayOfWeek', 'isRushHour', 'temperature', 'precipitation',
  'windSpeed', 'currentDelay', 'routeFrequency', 'stopPopularity',
];

const LABELS = ['low', 'medium', 'high'];

let model = null;
let trainMetrics = null;

/**
 * Train the crowd estimation model
 */
function train() {
  console.log('   Training crowd estimation model...');
  const start = Date.now();

  const { X: trainX, y: trainY } = generateCrowdDataset(2000);
  const { X: testX, y: testY } = generateCrowdDataset(400);

  model = new RandomForestClassifier({
    nEstimators: 40,
    maxFeatures: 0.7,
    replacement: true,
    seed: 42,
    useSampleBagging: true,
  });

  model.train(trainX, trainY);

  // Evaluate
  const predictions = model.predict(testX);
  let correct = 0;
  const confusion = [[0,0,0],[0,0,0],[0,0,0]];

  for (let i = 0; i < testY.length; i++) {
    if (predictions[i] === testY[i]) correct++;
    confusion[testY[i]][predictions[i]]++;
  }

  const accuracy = (correct / testY.length) * 100;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  // Per-class precision and recall
  const classMetrics = LABELS.map((label, idx) => {
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
  };

  console.log(`   ✅ Crowd model trained in ${elapsed}s — Accuracy: ${trainMetrics.accuracy}%`);
}

/**
 * Predict crowd level for given conditions
 * @param {Object} conditions - { hour, dayOfWeek, isRushHour, temperature, precipitation, windSpeed, currentDelay, routeFrequency, stopPopularity }
 * @returns {{ level, estimatedCount, confidence, reason, trend }}
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

  const prediction = model.predict([features])[0];
  const level = LABELS[prediction];

  // Get class probabilities from tree votes
  const treePredictions = model.estimators.map(tree => {
    return tree.predict([features])[0];
  });

  const votes = [0, 0, 0];
  treePredictions.forEach(p => votes[p]++);
  const total = treePredictions.length;
  const probabilities = votes.map(v => parseFloat(((v / total) * 100).toFixed(1)));

  const confidence = Math.round(probabilities[prediction]);

  // Estimated count based on level
  const countRanges = { low: [2, 10], medium: [12, 28], high: [30, 55] };
  const range = countRanges[level];
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

  return {
    level,
    estimatedCount,
    confidence,
    probabilities: { low: probabilities[0], medium: probabilities[1], high: probabilities[2] },
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
    if (level === 'low') parts.push('off-peak period, favorable conditions');
    else if (level === 'medium') parts.push('moderate passenger demand');
    else parts.push('multiple congestion factors');
  }

  return parts.join(', ').replace(/^./, c => c.toUpperCase());
}

function getMetrics() {
  return trainMetrics;
}

module.exports = { train, predict, getMetrics, LABELS };
