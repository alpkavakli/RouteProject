// ─── Prediction Service ─────────────────────────────────────────────────
// Coordinates arrival and crowd models, generates final predictions for the API

const arrivalModel = require('./arrival-model');
const crowdModel = require('./crowd-model');
const { loadRealArrivalDataset, loadRealCrowdDataset } = require('./data-generator');

let currentWeather = { temperature: 20, precipitation: 0, windSpeed: 10 };
let isInitialized = false;
let dataSource = 'synthetic';

// ─── Real Schedule Lookup ────────────────────────────────────────────────
// Converts MySQL TIME ("HH:MM:SS" or Date) to minutes-since-midnight
function timeToMinutes(t) {
  if (t == null) return 0;
  const s = typeof t === 'string' ? t : t.toString();
  const parts = s.split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0) + (parts[2] || 0) / 60;
}

function classifyOccupancyPct(pct) {
  if (pct < 15) return 'empty';
  if (pct < 35) return 'light';
  if (pct < 60) return 'moderate';
  if (pct < 80) return 'busy';
  return 'crowded';
}

function formatTimeHHMM(t) {
  if (t == null) return null;
  const s = typeof t === 'string' ? t : t.toString();
  const parts = s.split(':');
  if (parts.length < 2) return null;
  return `${String(parts[0]).padStart(2, '0')}:${String(parts[1]).padStart(2, '0')}`;
}

// Query the hackathon data for the real next scheduled arrival
// for a given (stop, line), on the current day-of-week, after now.
// When the next scheduled arrival is more than this many minutes away, we
// treat the line as being in a "service gap" — effectively no active service
// right now. This covers both the late-night case (after the day's last trip)
// and the overnight case (past midnight but before the next day's first trip).
const SERVICE_GAP_MIN = 180;

// Batch-load schedule data for ALL lines at a given stop in ~3 SQL round-trips
// (was N+1: up to 5 queries × 5 lines = 25 round-trips per advice request).
async function loadAllSchedules(pool, stopId, lineIds, dayOfWeek, nowMinutes) {
  if (!lineIds || lineIds.length === 0) return {};
  const nowTimeStr = `${String(Math.floor(nowMinutes / 60)).padStart(2, '0')}:${String(Math.floor(nowMinutes % 60)).padStart(2, '0')}:00`;

  // 1. Fetch up to 3 upcoming arrivals per line in one query (today's DOW, after now)
  const placeholders = lineIds.map(() => '?').join(',');
  const [allRows] = await pool.execute(
    `SELECT a.line_id, a.trip_id, a.scheduled_arrival, a.stop_sequence,
            a.delay_min AS historical_delay, a.passengers_waiting,
            t.avg_occupancy_pct, t.speed_factor, t.bus_capacity,
            t.departure_delay_min, t.temperature_c, t.precipitation_mm,
            t.traffic_level, t.day_of_week
     FROM hackathon_arrivals a
     JOIN hackathon_trips t ON a.trip_id = t.trip_id
     WHERE a.stop_id = ? AND a.line_id IN (${placeholders})
     ORDER BY a.line_id, a.scheduled_arrival ASC`,
    [stopId, ...lineIds]
  );

  // 2. Batch avg delay per line (one query for all lines)
  const [delayRows] = await pool.execute(
    `SELECT line_id, AVG(delay_min) AS avg_delay
     FROM hackathon_arrivals
     WHERE stop_id = ? AND line_id IN (${placeholders})
     GROUP BY line_id`,
    [stopId, ...lineIds]
  );
  const delayByLine = {};
  for (const r of delayRows) delayByLine[r.line_id] = Number(r.avg_delay) || 0;

  // 3. Partition rows by line and compute per-line results in JS
  const byLine = {};
  for (const row of allRows) {
    if (!byLine[row.line_id]) byLine[row.line_id] = [];
    byLine[row.line_id].push(row);
  }

  const results = {};
  for (const lineId of lineIds) {
    const lineRows = byLine[lineId] || [];
    if (lineRows.length === 0) { results[lineId] = null; continue; }

    let serviceEnded = false;

    // Filter: today's DOW, after now
    let candidates = lineRows.filter(
      r => Number(r.day_of_week) === dayOfWeek && r.scheduled_arrival > nowTimeStr
    );

    // Fallback 1: today's DOW, any time (wrap to first trip)
    if (candidates.length === 0) {
      serviceEnded = true;
      candidates = lineRows.filter(r => Number(r.day_of_week) === dayOfWeek);
    }
    // Fallback 2: any DOW
    if (candidates.length === 0) {
      candidates = lineRows;
    }
    if (candidates.length === 0) { results[lineId] = null; continue; }

    // Take first 3
    candidates = candidates.slice(0, 3);
    const primary = candidates[0];
    const schedMinutes = timeToMinutes(primary.scheduled_arrival);
    let minutesUntil = schedMinutes - nowMinutes;
    if (minutesUntil <= 0) minutesUntil += 24 * 60;
    if (minutesUntil >= SERVICE_GAP_MIN) serviceEnded = true;

    const nextBusSchedMinutes = candidates[1] ? timeToMinutes(candidates[1].scheduled_arrival) : null;
    const minutesToNextBus = nextBusSchedMinutes != null
      ? Math.max(1, Math.round(nextBusSchedMinutes - schedMinutes))
      : null;

    // Last trip check: are there any later trips today for this line?
    const laterCount = lineRows.filter(
      r => Number(r.day_of_week) === dayOfWeek && r.scheduled_arrival > primary.scheduled_arrival
    ).length;
    const isLastTripToday = !serviceEnded && laterCount === 0;

    results[lineId] = {
      tripId: primary.trip_id,
      scheduledMin: Math.max(1, Math.round(minutesUntil)),
      stopSequence: primary.stop_sequence || 1,
      avgOccupancyPct: Number(primary.avg_occupancy_pct) || null,
      speedFactor: Number(primary.speed_factor) || 1,
      busCapacity: Number(primary.bus_capacity) || 60,
      historicalDelay: Number(primary.historical_delay) || 0,
      passengersWaiting: Number(primary.passengers_waiting) || 0,
      recentAvgDelay: delayByLine[lineId] || 0,
      departureDelayMin: Number(primary.departure_delay_min) || 0,
      tripTemperatureC: Number(primary.temperature_c),
      tripPrecipitationMm: Number(primary.precipitation_mm),
      trafficLevel: primary.traffic_level || null,
      minutesToNextBus,
      serviceEnded,
      isLastTripToday,
      firstBusTimeStr: serviceEnded ? formatTimeHHMM(primary.scheduled_arrival) : null,
      firstBusHoursUntil: serviceEnded ? Math.round(minutesUntil / 60 * 10) / 10 : null,
      lastBusTimeStr: isLastTripToday ? formatTimeHHMM(primary.scheduled_arrival) : null,
    };
  }
  return results;
}

/**
 * Initialize and train all models
 * @param {Object} pool - MySQL connection pool (optional, for real data training)
 */
async function init(pool) {
  console.log('\n🧠 Initializing ML models...');
  const start = Date.now();

  let usedRealData = false;

  // Try to train on real hackathon data if pool is available
  if (pool) {
    try {
      const [arrivalDataset, crowdDataset] = await Promise.all([
        loadRealArrivalDataset(pool),
        loadRealCrowdDataset(pool),
      ]);

      if (arrivalDataset && arrivalDataset.total > 100) {
        arrivalModel.trainFromRealData(arrivalDataset);
        usedRealData = true;
      }

      if (crowdDataset && crowdDataset.total > 100) {
        crowdModel.trainFromRealData(crowdDataset);
        usedRealData = true;
      }
    } catch (err) {
      console.log(`   ⚠️ Real data loading failed: ${err.message}, falling back to synthetic`);
    }
  }

  // Fallback to synthetic training if real data wasn't available
  if (!usedRealData) {
    arrivalModel.train();
    crowdModel.train();
    dataSource = 'synthetic';
  } else {
    dataSource = 'hackathon_real';
  }

  isInitialized = true;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`🧠 All models ready in ${elapsed}s (source: ${dataSource})\n`);
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
 * Predict arrivals for a stop.
 * When `pool` is provided and the stop's line has hackathon data, inputs
 * (next scheduled departure, historical delay, occupancy, speed factor) are
 * pulled from the DB so the output is stable for the current minute.
 * Otherwise falls back to the synthetic simulation.
 *
 * @param {Object} stop - { id, routes, popularity, avg_delay, ... }
 * @param {Array} routes - all route objects for the stop's city
 * @param {Object} [pool] - MySQL pool for real-data lookups (optional)
 * @returns {Promise<Array>} arrival predictions sorted by predictedMin
 */
async function predictArrivals(stop, routes, pool) {
  const now = new Date();
  const hour = now.getHours();
  const jsDay = now.getDay();                    // JS: Sun=0..Sat=6
  const isWeekday = jsDay >= 1 && jsDay <= 5;    // Mon..Fri (wall clock)
  const isRushHour = isWeekday && ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19));
  // The hackathon CSV uses ISO day numbering (Mon=0..Sun=6). The ML model
  // was trained on that convention and the SQL rows are indexed by it, so
  // all model inputs and schedule queries must use the converted value.
  const dayOfWeek = (jsDay + 6) % 7;
  const nowMinutes = hour * 60 + now.getMinutes() + now.getSeconds() / 60;

  const profile = { popularity: stop.popularity || 0.5, avgDelay: stop.avg_delay || 2 };

  // Batch-load all schedules upfront (2 SQL queries instead of 25)
  let scheduleMap = {};
  if (pool) {
    try {
      scheduleMap = await loadAllSchedules(pool, stop.id, stop.routes, dayOfWeek, nowMinutes);
    } catch (_) { /* fallback to synthetic for all routes */ }
  }

  const results = await Promise.all(stop.routes.map(async (routeId) => {
    const route = routes.find(r => r.id === routeId);
    if (!route) return null;

    // Use pre-loaded schedule data
    const real = scheduleMap[routeId] || null;

    let scheduledMin, recentDelay, segmentIndex, vehicleId;
    let realOccupancyPct = null;
    let realSpeedFactor = 1;
    let realNextBusMin = null;
    let busCapacity = 60;
    let serviceEnded = false;
    let isLastTripToday = false;
    let firstBusTimeStr = null;
    let lastBusTimeStr = null;

    if (real) {
      scheduledMin = real.scheduledMin;
      recentDelay = real.recentAvgDelay;
      segmentIndex = real.stopSequence;
      vehicleId = real.tripId;
      realOccupancyPct = real.avgOccupancyPct;
      realSpeedFactor = real.speedFactor;
      realNextBusMin = real.minutesToNextBus;
      busCapacity = real.busCapacity;
      serviceEnded = !!real.serviceEnded;
      isLastTripToday = !!real.isLastTripToday;
      firstBusTimeStr = real.firstBusTimeStr;
      lastBusTimeStr = real.lastBusTimeStr;
    } else {
      scheduledMin = 3 + Math.floor(Math.random() * 20);
      recentDelay = Math.random() < 0.35 ? Math.random() * 6 : 0;
      segmentIndex = Math.max(1, (route.stops || []).indexOf(stop.id) + 1);
      vehicleId = `V-${1000 + Math.floor(Math.random() * 9000)}`;
    }

    // ─── ML delay prediction on top of real inputs ───────────────────
    // Prefer the weather captured on the actual matched trip so predictions
    // don't drift with the synthetic global weather fallback.
    const tempForPrediction = real && !Number.isNaN(real.tripTemperatureC)
      ? real.tripTemperatureC : currentWeather.temperature;
    const precipForPrediction = real && !Number.isNaN(real.tripPrecipitationMm)
      ? real.tripPrecipitationMm : currentWeather.precipitation;

    const prediction = arrivalModel.predict({
      hour,
      dayOfWeek,
      isRushHour,
      temperature: tempForPrediction,
      precipitation: precipForPrediction,
      windSpeed: currentWeather.windSpeed,
      scheduledMinutes: scheduledMin,
      stopPopularity: profile.popularity,
      routeAvgDelay: profile.avgDelay,
      recentDelay,
      segmentIndex,
    });

    const predictedMin = Math.max(1, Math.round(scheduledMin + prediction.predictedDelay));
    const delayMin = prediction.predictedDelay;

    let status = 'on-time';
    if (delayMin > 2) status = 'delayed';
    else if (delayMin < -0.5) status = 'early';

    // ─── Occupancy: real trip avg blended with ML crowd class ────────
    const mlOcc = crowdModel.predict({
      hour, dayOfWeek, isRushHour,
      temperature: currentWeather.temperature,
      precipitation: currentWeather.precipitation,
      windSpeed: currentWeather.windSpeed,
      currentDelay: Math.max(0, delayMin),
      routeFrequency: 8,
      stopPopularity: profile.popularity * 0.8,
    });

    let occupancyLevel = mlOcc.level;
    if (realOccupancyPct != null && !Number.isNaN(realOccupancyPct)) {
      // Real trip average is the strong signal; classify directly
      occupancyLevel = classifyOccupancyPct(realOccupancyPct);
    }

    return {
      routeId: route.id,
      routeName: route.name,
      routeColor: route.color,
      destination: route.name.split('–').pop() || route.name.split('-').pop() || route.name,
      scheduledMin,
      predictedMin,
      delayMin: parseFloat(delayMin.toFixed(1)),
      status,
      confidence: prediction.confidence,
      vehicleId,
      occupancy: occupancyLevel,
      factors: prediction.factors,
      mlPowered: true,
      // Real-data extras consumed by the advisor
      realOccupancyPct,
      realSpeedFactor,
      realNextBusMin,
      busCapacity,
      serviceEnded,
      isLastTripToday,
      firstBusTimeStr,
      lastBusTimeStr,
      fromRealData: !!real,
    };
  }));

  return results.filter(Boolean).sort((a, b) => a.predictedMin - b.predictedMin);
}

/**
 * Predict crowd level for a stop
 */
function predictCrowd(stop, arrivals = []) {
  const now = new Date();
  const hour = now.getHours();
  const jsDay = now.getDay();
  const isWeekday = jsDay >= 1 && jsDay <= 5;
  const isRushHour = isWeekday && ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19));
  // CSV uses ISO day-of-week (Mon=0..Sun=6); match it for the model input.
  const dayOfWeek = (jsDay + 6) % 7;

  const stopId = typeof stop === 'string' ? stop : stop.id;
  const profile = { popularity: (typeof stop === 'object' ? stop.popularity : null) || 0.5 };

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
    dataSource,
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
      classes: crowdModel.getLabels(),
    },
    currentWeather,
    lastUpdated: new Date().toISOString(),
  };
}

module.exports = {
  init, setWeather, predictArrivals, predictCrowd, getModelInfo,
  // Exposed for unit testing (pure helpers, no DB / no globals)
  _internal: { timeToMinutes, classifyOccupancyPct, formatTimeHHMM, SERVICE_GAP_MIN },
};
