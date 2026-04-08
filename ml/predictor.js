// ─── Prediction Service ─────────────────────────────────────────────────
// Coordinates arrival and crowd models, generates final predictions for the API

const arrivalModel = require('./arrival-model');
const crowdModel = require('./crowd-model');
const { STOP_PROFILES } = require('./data-generator');

let currentWeather = { temperature: 20, precipitation: 0, windSpeed: 10 };
let isInitialized = false;

/**
 * Initialize and train all models
 */
async function init() {
  console.log('\n🧠 Initializing ML models...');
  const start = Date.now();

  arrivalModel.train();
  crowdModel.train();

  isInitialized = true;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`🧠 All models ready in ${elapsed}s\n`);
}

/**
 * Update the current weather conditions (call periodically)
 */
function setWeather(weather) {
  currentWeather = {
    temperature: weather.temp || weather.temperature || 20,
    precipitation: weather.precipitation || 0,
    windSpeed: weather.windSpeed || 10,
  };
}

/**
 * Predict arrivals for a stop
 * @param {Object} stop - { id, routes, ... }
 * @param {Array} routes - all route objects
 * @returns {Array} arrival predictions
 */
function predictArrivals(stop, routes) {
  const now = new Date();
  const hour = now.getHours();
  const dayOfWeek = now.getDay();
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isRushHour = isWeekday && ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19));

  const profile = STOP_PROFILES[stop.id] || { popularity: 0.5, avgDelay: 2 };

  return stop.routes.map((routeId, idx) => {
    const route = routes.find(r => r.id === routeId);
    if (!route) return null;

    // Base scheduled time (simulate)
    const scheduledMin = 3 + Math.floor(Math.random() * 20);
    const segmentIndex = (route.stops || []).indexOf(stop.id) + 1;
    const recentDelay = Math.random() < 0.35 ? Math.random() * 6 : 0;

    // ML prediction
    const prediction = arrivalModel.predict({
      hour,
      dayOfWeek,
      isRushHour,
      temperature: currentWeather.temperature,
      precipitation: currentWeather.precipitation,
      windSpeed: currentWeather.windSpeed,
      scheduledMinutes: scheduledMin,
      stopPopularity: profile.popularity,
      routeAvgDelay: profile.avgDelay,
      recentDelay,
      segmentIndex: Math.max(1, segmentIndex),
    });

    const predictedMin = Math.max(1, Math.round(scheduledMin + prediction.predictedDelay));
    const delayMin = prediction.predictedDelay;

    let status = 'on-time';
    if (delayMin > 2) status = 'delayed';
    else if (delayMin < -0.5) status = 'early';

    // Bus occupancy prediction (simplified from crowd model)
    const occCond = {
      hour, dayOfWeek, isRushHour,
      temperature: currentWeather.temperature,
      precipitation: currentWeather.precipitation,
      windSpeed: currentWeather.windSpeed,
      currentDelay: Math.max(0, delayMin),
      routeFrequency: 8,
      stopPopularity: profile.popularity * 0.8, // vehicle is slightly different from stop
    };
    const occPred = crowdModel.predict(occCond);

    return {
      routeId: route.id,
      routeName: route.name,
      routeColor: route.color,
      destination: route.name.split('–').pop() || route.name,
      scheduledMin,
      predictedMin,
      delayMin: parseFloat(delayMin.toFixed(1)),
      status,
      confidence: prediction.confidence,
      vehicleId: `V-${1000 + Math.floor(Math.random() * 9000)}`,
      occupancy: occPred.level,
      factors: prediction.factors,
      mlPowered: true,
    };
  }).filter(Boolean).sort((a, b) => a.predictedMin - b.predictedMin);
}

/**
 * Predict crowd level for a stop
 * @param {string} stopId
 * @param {Array} arrivals - current arrival predictions (for delay context)
 * @returns {Object} crowd prediction
 */
function predictCrowd(stopId, arrivals = []) {
  const now = new Date();
  const hour = now.getHours();
  const dayOfWeek = now.getDay();
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isRushHour = isWeekday && ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19));

  const profile = STOP_PROFILES[stopId] || { popularity: 0.5 };

  // Average delay from current arrivals
  const avgDelay = arrivals.length > 0
    ? arrivals.reduce((sum, a) => sum + Math.max(0, a.delayMin), 0) / arrivals.length
    : 0;

  const prediction = crowdModel.predict({
    hour,
    dayOfWeek,
    isRushHour,
    temperature: currentWeather.temperature,
    precipitation: currentWeather.precipitation,
    windSpeed: currentWeather.windSpeed,
    currentDelay: avgDelay,
    routeFrequency: 8,
    stopPopularity: profile.popularity,
  });

  return {
    stopId,
    level: prediction.level,
    estimatedCount: prediction.estimatedCount,
    confidence: prediction.confidence,
    probabilities: prediction.probabilities,
    reason: prediction.reason,
    trend: prediction.trend,
    updatedAgo: 0,
    mlPowered: true,
  };
}

/**
 * Get model information for the /api/model/info endpoint
 */
function getModelInfo() {
  return {
    initialized: isInitialized,
    arrivalModel: {
      type: 'Random Forest Regressor',
      ...arrivalModel.getMetrics(),
      features: [
        'hour', 'dayOfWeek', 'isRushHour', 'temperature', 'precipitation',
        'windSpeed', 'scheduledMinutes', 'stopPopularity', 'routeAvgDelay',
        'recentDelay', 'segmentIndex',
      ],
    },
    crowdModel: {
      type: 'Random Forest Classifier',
      ...crowdModel.getMetrics(),
      features: [
        'hour', 'dayOfWeek', 'isRushHour', 'temperature', 'precipitation',
        'windSpeed', 'currentDelay', 'routeFrequency', 'stopPopularity',
      ],
      classes: ['low', 'medium', 'high'],
    },
    currentWeather,
    lastUpdated: new Date().toISOString(),
  };
}

module.exports = { init, setWeather, predictArrivals, predictCrowd, getModelInfo };
