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
};
