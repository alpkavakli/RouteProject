// ─── Synthetic Data Generator ───────────────────────────────────────────
// Creates realistic training data for arrival time prediction and crowd estimation
// Encodes real-world patterns: rush hours, weather effects, route profiles, weekday/weekend

const STOP_PROFILES = {
  'ist-1': { popularity: 0.95, avgDelay: 3.0 },  // Taksim - very busy
  'ist-2': { popularity: 0.80, avgDelay: 2.5 },
  'ist-3': { popularity: 0.90, avgDelay: 3.5 },  // Eminönü - old town congestion
  'ist-4': { popularity: 0.75, avgDelay: 2.0 },
  'ist-5': { popularity: 0.70, avgDelay: 2.2 },
  'ist-6': { popularity: 0.60, avgDelay: 1.5 },
  'ist-7': { popularity: 0.85, avgDelay: 3.2 },  // Sultanahmet - tourist zone
  'ist-8': { popularity: 0.65, avgDelay: 2.0 },
  'ank-1': { popularity: 0.90, avgDelay: 2.5 },  // Kızılay - center
  'ank-2': { popularity: 0.75, avgDelay: 2.0 },
  'ank-3': { popularity: 0.60, avgDelay: 1.5 },
  'ank-4': { popularity: 0.50, avgDelay: 1.2 },
  'ank-5': { popularity: 0.70, avgDelay: 2.0 },
  'ank-6': { popularity: 0.55, avgDelay: 1.8 },
  'ank-7': { popularity: 0.65, avgDelay: 1.5 },
};

function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function randInt(min, max) {
  return Math.floor(rand(min, max + 1));
}

function gaussianNoise(mean, stddev) {
  // Box-Muller transform
  const u1 = Math.random();
  const u2 = Math.random();
  return mean + stddev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Generate a single arrival training sample
 * Features: [hour, dayOfWeek, isRushHour, temperature, precipitation, windSpeed,
 *            scheduledMinutes, stopPopularity, routeAvgDelay, recentDelay, segmentIndex]
 * Target: actualDelayMinutes (positive = late, negative = early)
 */
function generateArrivalSample() {
  const hour = randInt(5, 23);
  const dayOfWeek = randInt(0, 6); // 0=Sunday
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isRushHour = isWeekday && ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19));
  const isMidRush = isWeekday && ((hour >= 10 && hour <= 11) || (hour >= 15 && hour <= 16));

  // Weather
  const temperature = rand(-5, 38);
  const precipitation = Math.random() < 0.3 ? rand(5, 80) : rand(0, 5);
  const windSpeed = rand(0, 45);
  const isRainy = precipitation > 15;
  const isStormy = precipitation > 40 || windSpeed > 30;

  // Route/stop context
  const stopIds = Object.keys(STOP_PROFILES);
  const stopId = stopIds[randInt(0, stopIds.length - 1)];
  const profile = STOP_PROFILES[stopId];
  const scheduledMinutes = rand(3, 30);
  const segmentIndex = randInt(1, 10); // how far along the route
  const recentDelay = Math.random() < 0.4 ? rand(0, 8) : 0;

  // ─── Compute actual delay based on realistic patterns ─────────
  let delay = 0;

  // Rush hour effect (biggest factor)
  if (isRushHour) {
    delay += rand(2, 6);
  } else if (isMidRush) {
    delay += rand(0.5, 2);
  }

  // Weather effects
  if (isRainy) {
    delay += rand(1.5, 4.5);
  }
  if (isStormy) {
    delay += rand(2, 5);
  }
  if (windSpeed > 20) {
    delay += rand(0.5, 2);
  }
  if (temperature < 0) {
    delay += rand(0.5, 1.5); // icy conditions
  }

  // Stop-specific delay profile
  delay += profile.avgDelay * rand(0.3, 1.2);

  // Propagation of recent delays
  if (recentDelay > 0) {
    delay += recentDelay * rand(0.3, 0.7);
  }

  // Route segment: further stops accumulate more delay
  delay += (segmentIndex / 10) * rand(0, 2);

  // Weekend typically less delay
  if (!isWeekday) {
    delay *= rand(0.3, 0.7);
  }

  // Add noise
  delay += gaussianNoise(0, 0.8);

  // Occasionally early
  if (Math.random() < 0.1 && !isRushHour) {
    delay = -rand(0.5, 2);
  }

  // Clamp
  delay = Math.max(-3, Math.min(15, delay));

  const features = [
    hour / 23,                          // normalized hour
    dayOfWeek / 6,                      // normalized day
    isRushHour ? 1 : 0,                 // binary
    temperature / 40,                   // normalized temp
    precipitation / 80,                 // normalized precip
    windSpeed / 45,                     // normalized wind
    scheduledMinutes / 30,              // normalized scheduled time
    profile.popularity,                 // 0-1
    profile.avgDelay / 4,               // normalized route avg delay
    recentDelay / 8,                    // normalized recent delay
    segmentIndex / 10,                  // normalized segment
  ];

  return { features, target: delay, meta: { stopId, hour, isRushHour, isRainy, windSpeed, recentDelay } };
}

/**
 * Generate a single crowd training sample
 * Features: [hour, dayOfWeek, isRushHour, temperature, precipitation, windSpeed,
 *            currentDelay, routeFrequency, stopPopularity]
 * Target: 0 = low, 1 = medium, 2 = high
 */
function generateCrowdSample() {
  const hour = randInt(5, 23);
  const dayOfWeek = randInt(0, 6);
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isRushHour = isWeekday && ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19));

  const temperature = rand(-5, 38);
  const precipitation = Math.random() < 0.3 ? rand(5, 80) : rand(0, 5);
  const windSpeed = rand(0, 45);

  const stopIds = Object.keys(STOP_PROFILES);
  const stopId = stopIds[randInt(0, stopIds.length - 1)];
  const profile = STOP_PROFILES[stopId];

  const currentDelay = Math.random() < 0.4 ? rand(1, 10) : rand(0, 2);
  const routeFrequency = rand(3, 15); // buses per hour

  // ─── Compute crowd level ──────────────────────────────────────
  let crowdScore = 0;

  // Rush hour → much more crowded
  if (isRushHour) crowdScore += rand(25, 45);

  // High delay → people accumulate
  if (currentDelay > 3) crowdScore += currentDelay * rand(2, 4);

  // Rain → more people use transit
  if (precipitation > 15) crowdScore += rand(10, 25);

  // Stop popularity
  crowdScore += profile.popularity * rand(10, 30);

  // Low frequency → more people waiting
  if (routeFrequency < 6) crowdScore += rand(5, 15);

  // Weekend → less
  if (!isWeekday) crowdScore *= rand(0.3, 0.6);

  // Late night → very low
  if (hour >= 22 || hour <= 5) crowdScore *= rand(0.1, 0.3);

  // Noise
  crowdScore += gaussianNoise(0, 5);
  crowdScore = Math.max(0, crowdScore);

  // Classify
  let label;
  if (crowdScore < 25) label = 0;       // low
  else if (crowdScore < 55) label = 1;  // medium
  else label = 2;                        // high

  const features = [
    hour / 23,
    dayOfWeek / 6,
    isRushHour ? 1 : 0,
    temperature / 40,
    precipitation / 80,
    windSpeed / 45,
    currentDelay / 10,
    routeFrequency / 15,
    profile.popularity,
  ];

  return { features, target: label, crowdScore, meta: { stopId, hour, isRushHour, precipitation, currentDelay } };
}

/**
 * Generate full datasets
 */
function generateArrivalDataset(n = 3000) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    samples.push(generateArrivalSample());
  }
  return {
    X: samples.map(s => s.features),
    y: samples.map(s => s.target),
  };
}

function generateCrowdDataset(n = 2000) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    samples.push(generateCrowdSample());
  }
  return {
    X: samples.map(s => s.features),
    y: samples.map(s => s.target),
  };
}

module.exports = {
  generateArrivalDataset,
  generateCrowdDataset,
  generateArrivalSample,
  generateCrowdSample,
  STOP_PROFILES,
  loadRealArrivalDataset,
  loadRealCrowdDataset,
};

// ─── Real Data Loaders (Hackathon) ──────────────────────────────────────

/**
 * Load real arrival training data from hackathon_arrivals + hackathon_trips
 * Features match the synthetic format so the same model architecture works.
 */
async function loadRealArrivalDataset(pool) {
  const [rows] = await pool.execute(`
    SELECT
      a.stop_sequence,
      a.delay_min,
      a.passengers_waiting,
      a.passengers_boarding,
      a.passengers_alighting,
      a.dwell_time_min,
      a.cumulative_delay_min,
      a.speed_factor,
      a.minutes_to_next_bus,
      a.weather_condition,
      t.day_of_week,
      t.is_weekend,
      t.departure_delay_min,
      t.temperature_c,
      t.precipitation_mm,
      t.wind_speed_kmh,
      t.avg_occupancy_pct,
      t.planned_duration_min,
      HOUR(a.scheduled_arrival) as hour_of_day
    FROM hackathon_arrivals a
    JOIN hackathon_trips t ON a.trip_id = t.trip_id
    ORDER BY RAND()
  `);

  if (rows.length === 0) return null;

  const X = [];
  const y = [];

  for (const r of rows) {
    const hour = r.hour_of_day || 12;
    const dayOfWeek = r.day_of_week || 0;
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
    const isRushHour = isWeekday && ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19));

    const features = [
      hour / 23,
      dayOfWeek / 6,
      isRushHour ? 1 : 0,
      (r.temperature_c || 20) / 40,
      (r.precipitation_mm || 0) / 80,
      (r.wind_speed_kmh || 10) / 45,
      (r.planned_duration_min || 30) / 60,  // normalized planned duration
      Math.min(1, (r.passengers_waiting || 0) / 150),  // stop popularity proxy
      (r.departure_delay_min || 0) / 10,  // route avg delay proxy
      (r.cumulative_delay_min || 0) / 15,  // recent delay
      (r.stop_sequence || 5) / 16,  // segment index (max 16 stops)
    ];

    X.push(features);
    y.push(r.delay_min || 0);
  }

  // 80/20 split
  const splitIdx = Math.floor(X.length * 0.8);
  return {
    train: { X: X.slice(0, splitIdx), y: y.slice(0, splitIdx) },
    test: { X: X.slice(splitIdx), y: y.slice(splitIdx) },
    total: X.length,
  };
}

/**
 * Load real crowd training data from hackathon_passenger_flow
 * Maps 5-class crowding levels to numeric labels: empty=0, light=1, moderate=2, busy=3, crowded=4
 */
async function loadRealCrowdDataset(pool) {
  const CROWD_MAP = { empty: 0, light: 1, moderate: 2, busy: 3, crowded: 4 };

  const [rows] = await pool.execute(`
    SELECT
      hour_of_day,
      day_of_week,
      is_weekend,
      weather_condition,
      avg_passengers_waiting,
      avg_passengers_boarding,
      avg_dwell_time_min,
      std_passengers_waiting,
      crowding_level,
      stop_type
    FROM hackathon_passenger_flow
    ORDER BY RAND()
  `);

  if (rows.length === 0) return null;

  const X = [];
  const y = [];

  // Weather encoding
  const WEATHER_MAP = { clear: 0, cloudy: 0.2, fog: 0.4, wind: 0.5, rain: 0.7, snow: 0.9 };

  for (const r of rows) {
    const hour = r.hour_of_day || 12;
    const dayOfWeek = r.day_of_week || 0;
    const isWeekday = !r.is_weekend;
    const isRushHour = isWeekday && ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19));

    const label = CROWD_MAP[r.crowding_level];
    if (label === undefined) continue;

    const features = [
      hour / 23,
      dayOfWeek / 6,
      isRushHour ? 1 : 0,
      (WEATHER_MAP[r.weather_condition] || 0),  // encoded weather
      Math.min(1, (r.avg_passengers_waiting || 0) / 150),  // normalized waiting
      Math.min(1, (r.avg_passengers_boarding || 0) / 100),  // normalized boarding
      (r.avg_dwell_time_min || 1) / 3,  // normalized dwell time
      Math.min(1, (r.std_passengers_waiting || 0) / 50),  // variability
      r.stop_type === 'terminal' ? 1 : r.stop_type === 'university' ? 0.8 : r.stop_type === 'hospital' ? 0.7 : 0.4,
    ];

    X.push(features);
    y.push(label);
  }

  // 80/20 split
  const splitIdx = Math.floor(X.length * 0.8);
  return {
    train: { X: X.slice(0, splitIdx), y: y.slice(0, splitIdx) },
    test: { X: X.slice(splitIdx), y: y.slice(splitIdx) },
    total: X.length,
    numClasses: 5,
  };
}
