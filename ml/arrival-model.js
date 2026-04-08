// ─── Arrival Time Prediction Model ──────────────────────────────────────
// Random Forest Regressor for predicting bus delay (minutes)

const { RandomForestRegression } = require('ml-random-forest');
const { generateArrivalDataset } = require('./data-generator');

const FEATURE_NAMES = [
  'hour', 'dayOfWeek', 'isRushHour', 'temperature', 'precipitation',
  'windSpeed', 'scheduledMinutes', 'stopPopularity', 'routeAvgDelay',
  'recentDelay', 'segmentIndex',
];

let model = null;
let trainMetrics = null;

/**
 * Train the arrival prediction model
 */
function train() {
  console.log('   Training arrival prediction model...');
  const start = Date.now();

  // Generate training data
  const { X: trainX, y: trainY } = generateArrivalDataset(3000);
  const { X: testX, y: testY } = generateArrivalDataset(500);

  // Train Random Forest
  model = new RandomForestRegression({
    nEstimators: 50,
    maxFeatures: 0.7,
    replacement: true,
    seed: 42,
    useSampleBagging: true,
  });

  model.train(trainX, trainY);

  // Evaluate on test set
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

  // Get predictions from all trees for confidence
  const treePredictions = model.estimators.map(tree => {
    return tree.predict([features])[0];
  });

  const predictedDelay = model.predict([features])[0];

  // Confidence: inverse of prediction variance across trees
  const mean = treePredictions.reduce((a, b) => a + b, 0) / treePredictions.length;
  const variance = treePredictions.reduce((a, b) => a + (b - mean) ** 2, 0) / treePredictions.length;
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

module.exports = { train, predict, getMetrics };
