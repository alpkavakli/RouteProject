// ─── Prediction Service ─────────────────────────────────────────────────
// Coordinates arrival and crowd models, generates final predictions for the API

const arrivalModel = require('./arrival-model');
const crowdModel = require('./crowd-model');
const { loadRealArrivalDataset, loadRealCrowdDataset } = require('./data-generator');

let currentWeather = { temperature: 20, precipitation: 0, windSpeed: 10 };
let isInitialized = false;
let dataSource = 'synthetic';

// Historical averages used when predicting for future times (same-week or
// later). Live `recentDelay` and live weather don't generalize, so we fall
// back to these route-conditioned priors keyed by (lineId, hour, dayOfWeek).
// Populated once in init() from hackathon_arrivals + hackathon_trips.
const historicalPriors = {
  delayByLineHourDow: new Map(),   // key = `${lineId}|${hour}|${dow}` → avg delay
  weatherByHourDow: new Map(),     // key = `${hour}|${dow}` → {temp, precip, wind}
  loaded: false,
};

function priorKey(lineId, hour, dow) { return `${lineId}|${hour}|${dow}`; }
function weatherKey(hour, dow) { return `${hour}|${dow}`; }

async function loadHistoricalPriors(pool) {
  try {
    // Join arrivals→trips so we get day_of_week (only on trips) and can
    // bucket per-stop observed delay by the hour the bus actually reached
    // the stop. This captures rush-hour delay signal better than departure
    // delay alone.
    const [delayRows] = await pool.query(`
      SELECT a.line_id,
             HOUR(a.scheduled_arrival) AS hour_of_day,
             t.day_of_week,
             AVG(a.delay_min) AS avg_delay
      FROM hackathon_arrivals a
      JOIN hackathon_trips t ON a.trip_id = t.trip_id
      WHERE a.delay_min IS NOT NULL
      GROUP BY a.line_id, hour_of_day, t.day_of_week
    `);
    historicalPriors.delayByLineHourDow.clear();
    for (const r of delayRows) {
      historicalPriors.delayByLineHourDow.set(
        priorKey(r.line_id, Number(r.hour_of_day), Number(r.day_of_week)),
        Number(r.avg_delay) || 0
      );
    }

    const [wxRows] = await pool.query(`
      SELECT HOUR(planned_departure) AS hour_of_day, day_of_week,
             AVG(temperature_c) AS avg_temp,
             AVG(precipitation_mm) AS avg_precip,
             AVG(wind_speed_kmh) AS avg_wind
      FROM hackathon_trips
      GROUP BY hour_of_day, day_of_week
    `);
    historicalPriors.weatherByHourDow.clear();
    for (const r of wxRows) {
      historicalPriors.weatherByHourDow.set(
        weatherKey(Number(r.hour_of_day), Number(r.day_of_week)),
        {
          temperature: Number(r.avg_temp) || 20,
          precipitation: Number(r.avg_precip) || 0,
          windSpeed: Number(r.avg_wind) || 10,
        }
      );
    }

    historicalPriors.loaded = true;
    console.log(`   📊 Priors loaded: ${historicalPriors.delayByLineHourDow.size} delay cells, ${historicalPriors.weatherByHourDow.size} weather cells`);
  } catch (err) {
    console.log(`   ⚠️ Prior computation failed: ${err.message}`);
  }
}

function priorDelay(lineId, hour, dow, fallback = 0) {
  return historicalPriors.delayByLineHourDow.get(priorKey(lineId, hour, dow)) ?? fallback;
}
function priorWeather(hour, dow) {
  return historicalPriors.weatherByHourDow.get(weatherKey(hour, dow)) || currentWeather;
}

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

// Batch-load schedule data for ALL lines at a given stop.
// Uses hackathon_trips (complete schedule, 350+ trips/day/line) as the primary
// source and interpolates per-stop arrival times from planned_departure +
// stop position. Enriches with hackathon_arrivals detail when available (that
// table is a sparse sample — often only 7 trips/day/line at a given stop).
async function loadAllSchedules(pool, stopId, lineIds, dayOfWeek, nowMinutes) {
  if (!lineIds || lineIds.length === 0) return {};

  const placeholders = lineIds.map(() => '?').join(',');

  // 1. Get this stop's position on each line (0-based)
  const [stopPositions] = await pool.execute(
    `SELECT route_id AS line_id, stop_order
     FROM route_stops
     WHERE stop_id = ? AND route_id IN (${placeholders})`,
    [stopId, ...lineIds]
  );
  const posByLine = {};
  for (const r of stopPositions) posByLine[r.line_id] = Number(r.stop_order);

  // 2. Fetch ALL trips for these lines on this day from hackathon_trips
  //    This is the COMPLETE schedule (350+ trips per line per day).
  const [tripRows] = await pool.execute(
    `SELECT trip_id, line_id, day_of_week, planned_departure,
            departure_delay_min, planned_duration_min, num_stops,
            avg_occupancy_pct, speed_factor, bus_capacity,
            temperature_c, precipitation_mm, traffic_level
     FROM hackathon_trips
     WHERE line_id IN (${placeholders})
     ORDER BY line_id, planned_departure ASC`,
    [...lineIds]
  );

  // 3. Optionally load per-stop detail from hackathon_arrivals (sparse)
  const [arrivalRows] = await pool.execute(
    `SELECT a.trip_id, a.line_id, a.scheduled_arrival, a.stop_sequence,
            a.delay_min AS historical_delay, a.passengers_waiting
     FROM hackathon_arrivals a
     WHERE a.stop_id = ? AND a.line_id IN (${placeholders})`,
    [stopId, ...lineIds]
  );
  const arrivalByTrip = {};
  for (const r of arrivalRows) arrivalByTrip[r.trip_id] = r;

  // 4. Batch avg delay per line
  const [delayRows] = await pool.execute(
    `SELECT line_id, AVG(delay_min) AS avg_delay
     FROM hackathon_arrivals
     WHERE stop_id = ? AND line_id IN (${placeholders})
     GROUP BY line_id`,
    [stopId, ...lineIds]
  );
  const delayByLine = {};
  for (const r of delayRows) delayByLine[r.line_id] = Number(r.avg_delay) || 0;

  // 5. For each line, interpolate arrival time at the target stop and pick candidates
  const byLine = {};
  for (const trip of tripRows) {
    if (!byLine[trip.line_id]) byLine[trip.line_id] = [];

    const stopOrder = posByLine[trip.line_id];
    if (stopOrder == null) continue;

    const numStops = Number(trip.num_stops) || 14;
    const segments = Math.max(1, numStops - 1);
    const durationMin = Number(trip.planned_duration_min) || 30;
    const depMinutes = timeToMinutes(trip.planned_departure);

    // Interpolate: arrival at this stop = departure + fraction of total duration
    const estimatedArrivalMin = depMinutes + (stopOrder / segments) * durationMin;

    // If we have per-stop detail from hackathon_arrivals, prefer that timing
    const detail = arrivalByTrip[trip.trip_id];
    const actualArrivalMin = detail ? timeToMinutes(detail.scheduled_arrival) : null;
    const arrivalMin = actualArrivalMin || estimatedArrivalMin;

    byLine[trip.line_id].push({
      ...trip,
      arrivalMin,
      estimatedArrivalMin,
      stopSequence: detail ? (detail.stop_sequence || stopOrder + 1) : stopOrder + 1,
      historicalDelay: detail ? (Number(detail.historical_delay) || 0) : 0,
      passengersWaiting: detail ? (Number(detail.passengers_waiting) || 0) : 0,
      hasDetail: !!detail,
    });
  }

  const results = {};
  for (const lineId of lineIds) {
    const lineTrips = byLine[lineId] || [];
    if (lineTrips.length === 0) { results[lineId] = null; continue; }

    let serviceEnded = false;

    // Filter: today's DOW, arriving after now
    let candidates = lineTrips.filter(
      r => Number(r.day_of_week) === dayOfWeek && r.arrivalMin > nowMinutes
    );

    // Fallback: today's DOW, any time (wrap to first trip tomorrow)
    if (candidates.length === 0) {
      serviceEnded = true;
      candidates = lineTrips.filter(r => Number(r.day_of_week) === dayOfWeek);
    }
    // Fallback: any DOW
    if (candidates.length === 0) {
      candidates = lineTrips;
    }
    if (candidates.length === 0) { results[lineId] = null; continue; }

    // Sort by arrival time and take first 3
    candidates.sort((a, b) => a.arrivalMin - b.arrivalMin);
    candidates = candidates.slice(0, 3);
    const primary = candidates[0];

    let minutesUntil = primary.arrivalMin - nowMinutes;
    if (minutesUntil <= 0) minutesUntil += 24 * 60;
    if (minutesUntil >= SERVICE_GAP_MIN) serviceEnded = true;

    const nextBusMin = candidates[1] ? candidates[1].arrivalMin : null;
    const minutesToNextBus = nextBusMin != null
      ? Math.max(1, Math.round(nextBusMin - primary.arrivalMin))
      : null;

    // Minutes-from-now for each candidate (bus #1, #2, #3), with midnight
    // wrap handled the same way as the primary. Consumers that want to show
    // "later buses today" iterate this array instead of synthesizing from
    // minutesToNextBus (which only exposes bus #2).
    const futureBusMins = candidates.map(c => {
      let m = c.arrivalMin - nowMinutes;
      if (m <= 0) m += 24 * 60;
      return Math.max(1, Math.round(m));
    });

    // Last trip: are there later trips today for this line?
    const laterCount = lineTrips.filter(
      r => Number(r.day_of_week) === dayOfWeek && r.arrivalMin > primary.arrivalMin
    ).length;
    const isLastTripToday = !serviceEnded && laterCount === 0;

    // Format arrival time for display
    const arrH = Math.floor(primary.arrivalMin / 60) % 24;
    const arrM = Math.floor(primary.arrivalMin % 60);
    const arrTimeStr = `${String(arrH).padStart(2, '0')}:${String(arrM).padStart(2, '0')}`;

    results[lineId] = {
      tripId: primary.trip_id,
      scheduledMin: Math.max(1, Math.round(minutesUntil)),
      stopSequence: primary.stopSequence || 1,
      avgOccupancyPct: Number(primary.avg_occupancy_pct) || null,
      speedFactor: Number(primary.speed_factor) || 1,
      busCapacity: Number(primary.bus_capacity) || 60,
      historicalDelay: primary.historicalDelay,
      passengersWaiting: primary.passengersWaiting,
      recentAvgDelay: delayByLine[lineId] || 0,
      departureDelayMin: Number(primary.departure_delay_min) || 0,
      tripTemperatureC: Number(primary.temperature_c),
      tripPrecipitationMm: Number(primary.precipitation_mm),
      trafficLevel: primary.traffic_level || null,
      minutesToNextBus,
      futureBusMins,
      serviceEnded,
      isLastTripToday,
      firstBusTimeStr: serviceEnded ? arrTimeStr : null,
      firstBusHoursUntil: serviceEnded ? Math.round(minutesUntil / 60 * 10) / 10 : null,
      lastBusTimeStr: isLastTripToday ? arrTimeStr : null,
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

  // Historical priors — used by predictAtTime() for future-target predictions
  // where live recentDelay/weather signals don't apply.
  if (pool) await loadHistoricalPriors(pool);

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
    let realFutureBusMins = null;
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
      realFutureBusMins = real.futureBusMins || null;
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
      realFutureBusMins,
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
 * Classify how far into the future the target is. Governs which features are
 * "live" vs substituted with historical priors.
 */
function classifyAccuracyTier(targetDate, now) {
  const sameDay = targetDate.toDateString() === now.toDateString();
  if (sameDay) return 'same-day';
  const daysAhead = (targetDate - now) / (1000 * 60 * 60 * 24);
  if (daysAhead <= 7) return 'same-week';
  return 'far-future';
}

/**
 * Predict which buses will be at this stop around a target time.
 *
 * Differs from predictArrivals() in that the target is not "now":
 *  - Scheduled arrivals at the stop are filtered to [target - win, target + win]
 *  - Features that don't generalize (recentDelay, live weather) are replaced
 *    with historical priors keyed by (lineId, hour, dayOfWeek).
 *  - Each option carries an `accuracyTier` so the UI can dim confidence when
 *    the target is days away.
 *
 * @param {Object} stop        - { id, routes, popularity, avg_delay, ... }
 * @param {Array}  routes      - all route objects for the stop's city
 * @param {Object} pool        - MySQL pool (required)
 * @param {Date}   targetDate  - desired arrival moment
 * @param {number} windowMin   - ± search window (minutes), clamped to [5, 90]
 */
async function predictAtTime(stop, routes, pool, targetDate, windowMin = 30) {
  if (!pool) return [];
  const win = Math.max(5, Math.min(90, Number(windowMin) || 30));

  const now = new Date();
  const targetHour = targetDate.getHours();
  const targetMinOfDay = targetHour * 60 + targetDate.getMinutes();
  const jsDay = targetDate.getDay();
  const isWeekday = jsDay >= 1 && jsDay <= 5;
  const isRushHour = isWeekday && ((targetHour >= 7 && targetHour <= 9) || (targetHour >= 17 && targetHour <= 19));
  const dayOfWeek = (jsDay + 6) % 7;
  const accuracyTier = classifyAccuracyTier(targetDate, now);

  const profile = { popularity: stop.popularity || 0.5, avgDelay: stop.avg_delay || 2 };
  const lineIds = stop.routes || [];
  if (lineIds.length === 0) return [];
  const placeholders = lineIds.map(() => '?').join(',');

  // Pull all trips on the target DOW and interpolate each one's arrival at
  // this stop (same technique as loadAllSchedules). Then filter to the window.
  const [tripRows] = await pool.execute(
    `SELECT trip_id, line_id, day_of_week, planned_departure,
            planned_duration_min, num_stops,
            avg_occupancy_pct, bus_capacity,
            temperature_c, precipitation_mm, traffic_level
     FROM hackathon_trips
     WHERE line_id IN (${placeholders}) AND day_of_week = ?
     ORDER BY line_id, planned_departure`,
    [...lineIds, dayOfWeek]
  );

  const [posRows] = await pool.execute(
    `SELECT rs.route_id AS line_id, rs.stop_order
     FROM route_stops rs
     WHERE rs.stop_id = ? AND rs.route_id IN (${placeholders})`,
    [stop.id, ...lineIds]
  );
  const posByLine = {};
  for (const r of posRows) posByLine[r.line_id] = Number(r.stop_order);

  const [arrivalDetail] = await pool.execute(
    `SELECT a.trip_id, a.scheduled_arrival, a.stop_sequence
     FROM hackathon_arrivals a
     WHERE a.stop_id = ? AND a.line_id IN (${placeholders})`,
    [stop.id, ...lineIds]
  );
  const detailByTrip = {};
  for (const r of arrivalDetail) detailByTrip[r.trip_id] = r;

  const matches = [];
  for (const trip of tripRows) {
    const stopOrder = posByLine[trip.line_id];
    if (stopOrder == null) continue;

    const numStops = Number(trip.num_stops) || 14;
    const segments = Math.max(1, numStops - 1);
    const durationMin = Number(trip.planned_duration_min) || 30;
    const depMin = timeToMinutes(trip.planned_departure);
    const estArrMin = depMin + (stopOrder / segments) * durationMin;

    const detail = detailByTrip[trip.trip_id];
    const scheduledMinOfDay = detail ? timeToMinutes(detail.scheduled_arrival) : estArrMin;

    // Circular distance handles target near midnight (e.g. target 00:15,
    // trip 23:50) — wrap is the minimum of forward / reverse gap.
    let diff = scheduledMinOfDay - targetMinOfDay;
    if (diff > 720) diff -= 1440;
    if (diff < -720) diff += 1440;
    if (Math.abs(diff) > win) continue;

    matches.push({
      trip,
      scheduledMinOfDay,
      diffFromTargetMin: diff,
      stopSequence: detail ? (detail.stop_sequence || stopOrder + 1) : stopOrder + 1,
    });
  }

  // Dedupe: the CSV covers multiple weeks, so each (line, scheduled-slot)
  // combo appears several times. Keep one synthetic entry per slot, averaging
  // the occupancy across weeks.
  const slotMap = new Map();
  for (const m of matches) {
    const key = `${m.trip.line_id}|${Math.round(m.scheduledMinOfDay)}`;
    const existing = slotMap.get(key);
    if (!existing) {
      slotMap.set(key, {
        ...m,
        occSum: Number(m.trip.avg_occupancy_pct) || 0,
        occCount: m.trip.avg_occupancy_pct != null ? 1 : 0,
      });
    } else {
      if (m.trip.avg_occupancy_pct != null) {
        existing.occSum += Number(m.trip.avg_occupancy_pct);
        existing.occCount += 1;
      }
    }
  }
  const deduped = [...slotMap.values()].map(m => ({
    ...m,
    trip: {
      ...m.trip,
      avg_occupancy_pct: m.occCount > 0 ? m.occSum / m.occCount : m.trip.avg_occupancy_pct,
    },
  }));

  if (deduped.length === 0) return [];

  // Build per-trip predictions. Live features are used only for same-day
  // within a ~2h future window; otherwise we fall back to priors.
  const sameDay = accuracyTier === 'same-day';
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const minutesToTarget = targetMinOfDay - nowMinutes;
  const useLiveWindow = sameDay && minutesToTarget > 0 && minutesToTarget <= 120;

  const results = deduped.map(({ trip, scheduledMinOfDay, diffFromTargetMin, stopSequence }) => {
    const route = routes.find(r => r.id === trip.line_id);
    if (!route) return null;

    const weather = useLiveWindow ? currentWeather : priorWeather(targetHour, dayOfWeek);
    const recentDelay = useLiveWindow
      ? priorDelay(trip.line_id, targetHour, dayOfWeek, profile.avgDelay)
      : priorDelay(trip.line_id, targetHour, dayOfWeek, profile.avgDelay);

    const scheduledMinutes = Math.max(
      1,
      Math.round(scheduledMinOfDay - timeToMinutes(trip.planned_departure))
    );

    const prediction = arrivalModel.predict({
      hour: targetHour,
      dayOfWeek,
      isRushHour,
      temperature: weather.temperature,
      precipitation: weather.precipitation,
      windSpeed: weather.windSpeed,
      scheduledMinutes,
      stopPopularity: profile.popularity,
      routeAvgDelay: profile.avgDelay,
      recentDelay,
      segmentIndex: stopSequence,
    });

    const predictedDelay = prediction.predictedDelay;
    const predictedMinOfDay = scheduledMinOfDay + predictedDelay;
    const diffFromTargetPredicted = predictedMinOfDay - targetMinOfDay;

    // Build absolute Date objects on the target date (not today) so the UI
    // can show real clock times even when scheduling far in advance.
    const scheduledAt = new Date(targetDate);
    scheduledAt.setHours(0, 0, 0, 0);
    scheduledAt.setMinutes(scheduledMinOfDay);
    const predictedAt = new Date(targetDate);
    predictedAt.setHours(0, 0, 0, 0);
    predictedAt.setMinutes(Math.round(predictedMinOfDay));

    // Occupancy: prefer trip's historical avg as the crowd signal — ML crowd
    // classifier isn't meaningful without live conditions.
    const occupancyPct = Number(trip.avg_occupancy_pct) || 50;
    const crowdLevel = classifyOccupancyPct(occupancyPct);

    return {
      routeId: route.id,
      routeName: route.name,
      routeColor: route.color,
      destination: route.name.split('–').pop() || route.name.split('-').pop() || route.name,
      tripId: trip.trip_id,
      scheduledAt: scheduledAt.toISOString(),
      predictedAt: predictedAt.toISOString(),
      predictedDelayMin: Number(predictedDelay.toFixed(1)),
      diffFromTargetMin: Number(Math.abs(diffFromTargetPredicted).toFixed(1)),
      diffSign: diffFromTargetPredicted < 0 ? 'early' : (diffFromTargetPredicted > 0 ? 'late' : 'on-time'),
      scheduledDiffMin: Number(diffFromTargetMin.toFixed(1)),
      crowdLevel,
      occupancyPct: Math.round(occupancyPct),
      confidence: prediction.confidence,
      accuracyTier,
      trafficLevel: trip.traffic_level || null,
    };
  }).filter(Boolean);

  // Sort by closeness to target (absolute predicted diff), tie-break on
  // scheduled time so earlier buses win when two options match equally.
  results.sort((a, b) => {
    const d = a.diffFromTargetMin - b.diffFromTargetMin;
    if (d !== 0) return d;
    return new Date(a.scheduledAt) - new Date(b.scheduledAt);
  });

  return results;
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
  init, setWeather, predictArrivals, predictAtTime, predictCrowd, getModelInfo,
  // Exposed for the live-bus engine (ml/live.js) — read-only use of the
  // historical priors that init() already loaded into memory.
  priorDelay,
  // Exposed for unit testing (pure helpers, no DB / no globals)
  _internal: { timeToMinutes, classifyOccupancyPct, formatTimeHHMM, SERVICE_GAP_MIN, classifyAccuracyTier },
};
