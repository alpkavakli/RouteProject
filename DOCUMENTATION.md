# Predictive Transit — Technical Documentation

This document walks through every part of the system: what it does, how it works, and why it was built this way.

---

## Table of Contents

1. [Problem and Approach](#1-problem-and-approach)
2. [System Architecture](#2-system-architecture)
3. [Backend — Server and API](#3-backend--server-and-api)
4. [ML Layer — How Predictions Work](#4-ml-layer--how-predictions-work)
   - 4.1 [Arrival Delay Model (Regression)](#41-arrival-delay-model-regression)
   - 4.2 [Crowd Estimation Model (Classification)](#42-crowd-estimation-model-classification)
   - 4.3 [Synthetic Data Generator](#43-synthetic-data-generator)
   - 4.4 [Predictor — Coordination Layer](#44-predictor--coordination-layer)
5. [Frontend — User Interface](#5-frontend--user-interface)
6. [Data Flow — End to End](#6-data-flow--end-to-end)
7. [Evaluation and Metrics](#7-evaluation-and-metrics)
8. [Deployment](#8-deployment)

---

## 1. Problem and Approach

Static bus timetables tell you "the bus is scheduled at 14:30" but in reality it might arrive at 14:35 or 14:42. The delay depends on factors that change by the minute: is it rush hour? is it raining? did the previous bus on this route get delayed? is this a busy stop where the bus spends extra time boarding passengers?

This project tackles two prediction tasks:

**Task 1: Arrival Delay Prediction** — Given a specific stop and route, predict how many minutes late (or early) the next bus will be. This is a regression problem. The model outputs a continuous value like +3.2 minutes.

**Task 2: Crowd Estimation** — Given a stop, predict whether the current crowd level is low, medium, or high. This is a classification problem. The model outputs a class label plus probabilities for each class.

Both tasks use **Random Forest** models — an ensemble of decision trees that each vote on the prediction. Random Forest was chosen because:
- It handles mixed feature types well (binary flags, continuous values, ratios)
- It provides natural confidence scoring (tree agreement = high confidence)
- It's fast enough to train on server startup without needing GPUs
- It doesn't overfit as aggressively as single decision trees

---

## 2. System Architecture

The system has three layers:

```
┌──────────────────────────────────────────────────────────────┐
│                        FRONTEND (Browser)                    │
│                                                              │
│   app.js ──→ data.js ──→ fetch("/api/...") ──→ server       │
│     │                                            │           │
│     ├── map.js (Leaflet map, markers, routes)    │           │
│     └── ui.js (cards, weather, model info)        │           │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                        API SERVER (Express.js)               │
│                                                              │
│   server.js                                                  │
│     ├── GET /api/stops          → static stop data           │
│     ├── GET /api/stops/:id      → single stop lookup         │
│     ├── GET /api/routes         → static route data          │
│     ├── GET /api/weather        → random weather generator   │
│     ├── GET /api/stops/:id/arrivals → predictor.predictArrivals()  │
│     ├── GET /api/stops/:id/crowd    → predictor.predictCrowd()     │
│     └── GET /api/model/info         → predictor.getModelInfo()     │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                        ML LAYER                              │
│                                                              │
│   predictor.js (coordinator)                                 │
│     ├── arrival-model.js   → RandomForestRegression (50 trees)    │
│     ├── crowd-model.js     → RandomForestClassifier (40 trees)    │
│     └── data-generator.js  → synthetic training data              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Key design decision:** Models train on startup, not pre-trained. When the server starts, it generates synthetic training data, trains both models (takes ~60 seconds), and only then begins accepting requests. This means:
- No model files to version or deploy
- Training metrics are always fresh and visible in logs
- The tradeoff is a 60-second startup delay

---

## 3. Backend — Server and API

**File: `server.js`**

The server is built on Express.js 5. It does three things:

### 3.1 Static Data

Stops and routes are hardcoded arrays inside `server.js`. There are 15 stops (8 in Istanbul, 7 in Ankara) and 16 routes. Each stop has:
- `id` — unique identifier like `ist-1` or `ank-3`
- `city` — Istanbul or Ankara
- `name` — human-readable name (e.g., "Taksim Meydani")
- `lat`, `lng` — GPS coordinates for map placement
- `routes` — array of route IDs that serve this stop

Each route has:
- `id` — like `T1`, `M1`, `124`
- `name` — full name (e.g., "T1 Kabatas-Bagcilar")
- `color` — hex color for UI rendering
- `stops` — ordered array of stop IDs along the route

### 3.2 Weather Generation

The `/api/weather` endpoint generates random weather conditions for a city. It picks a random condition (Clear, Partly Cloudy, Rainy, Overcast, Windy) with appropriate temperature, humidity, wind speed, and precipitation values.

Weather data serves two purposes:
1. Displayed to the user in the header widget
2. **Fed into the ML models as features** — the predictor uses temperature, precipitation, and wind speed when making predictions. When weather is fetched, it's cached in `currentWeatherCache` and passed to `predictor.setWeather()`.

### 3.3 ML-Powered Endpoints

The two core endpoints call into the ML prediction layer:

**`GET /api/stops/:id/arrivals`** — Looks up the stop, ensures weather exists for that city, then calls `predictor.predictArrivals(stop, routes)`. Returns an array of arrival predictions, one per route serving the stop.

**`GET /api/stops/:id/crowd`** — Same setup, but first generates arrival predictions (to extract current delay data), then calls `predictor.predictCrowd(stopId, arrivals)`. The crowd model uses the average delay from current arrivals as a feature — if buses are delayed, more people accumulate at the stop.

### 3.4 Startup Flow

```javascript
async function start() {
  await predictor.init();     // trains both models (~60s)
  app.listen(PORT, () => {    // only then start accepting requests
    console.log('Server running...');
  });
}
```

---

## 4. ML Layer — How Predictions Work

### 4.1 Arrival Delay Model (Regression)

**File: `ml/arrival-model.js`**

This model answers: "How many minutes late will this bus be?"

#### Features

The model takes 11 input features, all normalized to roughly 0-1 range:

| Feature | Raw Range | Normalization | Role |
|---------|-----------|---------------|------|
| `hour` | 0-23 | ÷ 23 | Time of day. Rush hours (7-9, 17-19) cause the most delay. |
| `dayOfWeek` | 0-6 | ÷ 6 | 0 = Sunday. Weekdays have more traffic. |
| `isRushHour` | 0 or 1 | binary | Explicit flag. Weekday + (7-9am or 5-7pm). |
| `temperature` | -5 to 38 | ÷ 40 | Sub-zero temperatures mean icy roads, slower driving. |
| `precipitation` | 0-80 mm | ÷ 80 | Rain > 15mm adds 1.5-4.5 min delay. Storms > 40mm even more. |
| `windSpeed` | 0-45 km/h | ÷ 45 | High wind > 20 km/h adds delay. Storms > 30 km/h add more. |
| `scheduledMinutes` | 3-30 | ÷ 30 | How long the ride is scheduled to take. Longer = more accumulated delay. |
| `stopPopularity` | 0-1 | already normalized | From stop profiles. Taksim = 0.95, Dikmen = 0.50. Busy stops mean more dwell time. |
| `routeAvgDelay` | 0-4 | ÷ 4 | Historical average delay for this route. Some routes are chronically late. |
| `recentDelay` | 0-8 | ÷ 8 | How late the previous bus was. Delays cascade — if the last bus was 5 min late, the next one is likely late too. |
| `segmentIndex` | 1-10 | ÷ 10 | How far along the route this stop is. Stop #8 accumulates more delay than stop #2. |

#### Model Configuration

```javascript
model = new RandomForestRegression({
  nEstimators: 50,        // 50 decision trees
  maxFeatures: 0.7,       // each tree sees 70% of features (prevents overfitting)
  replacement: true,      // bootstrap sampling
  seed: 42,               // reproducible results
  useSampleBagging: true, // each tree trains on a random subset of data
});
```

- **50 trees** provide a good balance between accuracy and training time.
- **maxFeatures: 0.7** means each tree randomly selects 7-8 of the 11 features. This decorrelates the trees — they each learn slightly different patterns, and their average is more robust than any single tree.
- **Bootstrap sampling** (replacement + bagging) means each tree trains on a random subset of the training data (with replacement). Some samples appear multiple times, others not at all. This further diversifies the ensemble.

#### Confidence Scoring

After the main model predicts a delay value, we also get each of the 50 individual trees to predict separately:

```javascript
const treePredictions = model.estimators.map(tree => {
  return tree.predict([features])[0];
});
```

If most trees agree (low variance), we're confident. If they disagree (high variance), we're less confident:

```javascript
const stddev = Math.sqrt(variance);
const confidence = Math.max(60, Math.min(98, Math.round(100 - stddev * 12)));
```

- Standard deviation of 0 across all trees → 98% confidence (capped)
- Standard deviation of 3.0 → 64% confidence
- Minimum confidence is 60% (the model never says "I have no idea")

#### Explainable Factors

After prediction, the model generates human-readable factors explaining **why** the delay is what it is:

```javascript
if (cond.isRushHour) {
  factors.push({ icon: '🕐', label: 'Rush hour', impact: '+2-5 min', type: 'negative' });
}
if (cond.precipitation > 15) {
  factors.push({ icon: '🌧️', label: 'Rain', impact: '+2-4 min', type: 'negative' });
}
```

These are rule-based, not extracted from the model's internals. They're derived from the same input conditions and give users interpretable reasons for the prediction. Types are `negative` (adds delay), `positive` (good conditions), or `neutral` (informational).

---

### 4.2 Crowd Estimation Model (Classification)

**File: `ml/crowd-model.js`**

This model answers: "How crowded is this stop right now?"

#### Features

9 features, a subset of the arrival model's features plus some crowd-specific ones:

| Feature | Role |
|---------|------|
| `hour` | Late-night stops are empty; rush hour stops are packed. |
| `dayOfWeek` | Weekend = less commuter traffic. |
| `isRushHour` | Direct crowd multiplier. |
| `temperature` | Extreme cold/heat affects whether people wait outside. |
| `precipitation` | Rain → more people use transit instead of walking → more crowded stops. |
| `windSpeed` | Storm conditions. |
| `currentDelay` | This is the key insight: if buses are delayed, people accumulate at the stop. A 6-minute delay means 6 extra minutes of people arriving but no bus picking them up. |
| `routeFrequency` | Buses per hour. Low frequency = longer waits = more people standing. |
| `stopPopularity` | Base demand for this stop. Taksim is always busier than Dikmen. |

#### Model Configuration

```javascript
model = new RandomForestClassifier({
  nEstimators: 40,        // 40 trees (fewer than arrival, since classification is simpler)
  maxFeatures: 0.7,
  replacement: true,
  seed: 42,
  useSampleBagging: true,
});
```

#### Classification Output

The model outputs 0, 1, or 2 (mapped to "low", "medium", "high"). But we go further:

**Probability distribution** — Each tree votes for a class. If 30 trees say "medium", 7 say "low", and 3 say "high", the probabilities are: low 17.5%, medium 75%, high 7.5%.

**Estimated count** — Based on the predicted level, we estimate an actual headcount:
- Low: 2-10 people
- Medium: 12-28 people
- High: 30-55 people

The exact number within each range is scaled by confidence — higher confidence pushes toward the middle of the range.

**Trend** — Based purely on time of day:
- 6-8am: rising (people arriving for morning commute)
- 9-11am: falling (rush hour ending)
- 4-5pm: rising (evening commute starting)
- 7-9pm: falling (commuters going home)
- Other times: stable

**Reason** — Human-readable explanation: "Rush hour congestion", "Rain increasing transit demand", "Bus delays causing passenger accumulation", "High-demand stop". Multiple factors are combined: "Rush hour congestion, rain increasing transit demand".

---

### 4.3 Synthetic Data Generator

**File: `ml/data-generator.js`**

Since we don't have access to real transit authority data, training data is generated synthetically. The generator encodes realistic patterns observed in Istanbul and Ankara public transit.

#### Stop Profiles

15 stops have individual profiles:

```javascript
const STOP_PROFILES = {
  'ist-1': { popularity: 0.95, avgDelay: 3.0 },  // Taksim - very busy
  'ist-3': { popularity: 0.90, avgDelay: 3.5 },  // Eminonu - old town congestion
  'ist-7': { popularity: 0.85, avgDelay: 3.2 },  // Sultanahmet - tourist zone
  'ank-1': { popularity: 0.90, avgDelay: 2.5 },  // Kizilay - Ankara center
  'ank-4': { popularity: 0.50, avgDelay: 1.2 },  // Dikmen - residential, low traffic
  // ...
};
```

These profiles capture that Taksim (Istanbul's busiest square) has very different delay characteristics than Dikmen (a quiet Ankara neighborhood).

#### How Delay is Calculated (Arrival Data)

Each training sample randomizes time, weather, and stop, then computes delay by stacking effects:

```
delay = 0
+ rush hour effect:     2-6 min (if weekday 7-9am or 5-7pm)
+ mid-rush effect:      0.5-2 min (if weekday 10-11am or 3-4pm)
+ rain effect:          1.5-4.5 min (if precipitation > 15mm)
+ storm effect:         2-5 min (if precipitation > 40mm or wind > 30 km/h)
+ wind effect:          0.5-2 min (if wind > 20 km/h)
+ ice effect:           0.5-1.5 min (if temperature < 0°C)
+ stop profile delay:   avgDelay * 0.3-1.2 (stop-specific base delay)
+ delay propagation:    recentDelay * 0.3-0.7 (cascading from previous bus)
+ segment accumulation: segmentIndex/10 * 0-2 min (further stops = more delay)
× weekend factor:       0.3-0.7 (weekends are calmer)
+ gaussian noise:       mean=0, stddev=0.8 (random variation)
```

10% of samples are marked as "early" (bus arrives before schedule) when conditions are good. Final delay is clamped to [-3, +15] minutes.

#### How Crowd Score is Calculated (Crowd Data)

Similar approach, but scoring crowd density:

```
crowdScore = 0
+ rush hour:       25-45 points
+ high delay:      delay * 2-4 points (people accumulate)
+ rain:            10-25 points (more people take transit)
+ stop popularity: popularity * 10-30 points
+ low frequency:   5-15 points (if < 6 buses/hour)
× weekend factor:  0.3-0.6
× late-night factor: 0.1-0.3 (if 10pm-5am)
+ gaussian noise:  mean=0, stddev=5
```

Then classified: < 25 = low, 25-55 = medium, > 55 = high.

#### Dataset Sizes

- Arrival model: **3,000 training** samples + **500 test** samples
- Crowd model: **2,000 training** samples + **400 test** samples

Each sample is independently randomized, so the dataset covers a wide variety of conditions.

---

### 4.4 Predictor — Coordination Layer

**File: `ml/predictor.js`**

The predictor sits between the server and the individual models. It handles:

#### Initialization

Trains both models sequentially on startup:

```javascript
async function init() {
  arrivalModel.train();   // generates 3500 samples, trains 50-tree RF
  crowdModel.train();     // generates 2400 samples, trains 40-tree RF
}
```

#### Weather State

Maintains a current weather state that's updated whenever the weather endpoint is called:

```javascript
let currentWeather = { temperature: 20, precipitation: 0, windSpeed: 10 };
```

Both models use this weather as input features.

#### Arrival Prediction Flow

`predictArrivals(stop, routes)` does the following for each route serving the stop:

1. Looks up the stop's profile (popularity, avgDelay)
2. Generates a simulated scheduled time (3-23 min)
3. Determines the segment index (how far along the route this stop is)
4. Simulates recent delay (35% chance of 0-6 min delay from previous bus)
5. Calls `arrivalModel.predict()` with all 11 features
6. Computes `predictedMin = scheduledMin + predictedDelay`
7. Determines status: on-time (delay < 2), delayed (delay > 2), or early (delay < -0.5)
8. Also calls `crowdModel.predict()` for vehicle occupancy
9. Returns the full prediction object

Results are sorted by predicted arrival time, and filtered to remove any routes that weren't found.

#### Crowd Prediction Flow

`predictCrowd(stopId, arrivals)` computes the average delay from current arrivals, then calls the crowd model with time, weather, and delay features.

#### Model Info

`getModelInfo()` returns training metrics from both models (MAE, accuracy, sample counts, feature lists, training time) plus current weather state. This powers both the footer display in the UI and the `/api/model/info` endpoint.

---

## 5. Frontend — User Interface

The frontend is a single-page application with no build step — just vanilla JS loaded via `<script>` tags.

### 5.1 App Controller (`js/app.js`)

Manages the application lifecycle:

- **Initialization:** Creates the map, loads data for the default city (Istanbul), sets up event listeners
- **City switching:** When the user clicks Istanbul/Ankara toggle, it reloads stops, routes, weather, and repositions the map
- **Stop selection:** When a stop is clicked (map or search), fetches arrivals + crowd predictions in parallel, renders them
- **Auto-refresh:** After selecting a stop, predictions refresh every 30 seconds via `setInterval`
- **Search:** Debounced (200ms) filter over all stops by name or route ID

### 5.2 Map Controller (`js/map.js`)

Uses Leaflet.js with CARTO dark basemap tiles:

- **Stop markers:** Custom SVG bus icons with a circular border. Selected stop gets a blue fill and 1.3x scale.
- **Route lines:** Dashed polylines connecting stops along each route, colored per route.
- **City presets:** Istanbul (41.0082, 28.9784) and Ankara (39.9334, 32.8597) with smooth fly-to animations.
- **Popups:** Shows stop name, city, and route badges on hover.

### 5.3 UI Renderer (`js/ui.js`)

Pure DOM manipulation — no framework, no virtual DOM. Builds HTML strings and sets `innerHTML`.

**Weather widget:** Icon + temperature + wind + humidity in the header.

**Crowd card:** Three dots indicating level (green/yellow/red), estimated count, trend with icon, confidence percentage, probability breakdown (L/M/H%), and human-readable reason.

**Arrival cards:** Each card shows:
- Route badge (colored)
- Destination name
- Live countdown timer (updates every 15 seconds, pulses at 1 min, shows "Arriving!" at 0)
- Status badge (On Time / Delayed / Early)
- Occupancy indicator
- Scheduled vs predicted time
- Confidence bar (green > 85%, yellow > 70%, red below)
- Delay factor chips (Rush hour, Rain, Wind, etc.)
- "Best Option" tag on the recommended arrival (first on-time/early with low crowd)

**Model info footer:** Shows "Random Forest ML, Trained on N samples", arrival MAE, crowd accuracy. Fetched once on load from `/api/model/info`.

### 5.4 Data Service (`js/data.js`)

Thin wrapper around `fetch()` for all API calls. Uses relative URLs so it works regardless of host/port. No error handling UI — the app silently degrades on network failures.

### 5.5 Styling

Three CSS files:
- **`variables.css`** — 90+ design tokens: colors (dark theme), spacing scale, typography, shadows, transitions, z-index layers
- **`base.css`** — CSS reset, scrollbar styling, utility classes
- **`components.css`** — All component styles: header, map overlays, search, side panel, crowd card, arrival cards, confidence bars, factor chips, ML badges, skeleton loaders, animations (slide-up, fade-in, shimmer, pulse)

The design is dark-themed with blue/purple accent gradients, glass-morphism effects on the search bar (backdrop-filter blur), and staggered entrance animations on arrival cards.

Responsive: on screens under 860px, the layout switches from side-by-side (map + panel) to stacked (map on top, panel below).

---

## 6. Data Flow — End to End

Here's what happens when a user clicks a stop:

```
1. User clicks stop marker on the map
       ↓
2. map.js: selectStop(stopId)
   - Updates marker icons (deselect old, highlight new)
   - Flies map camera to the stop
   - Calls onStopSelect callback
       ↓
3. app.js: onStopSelected(stopId)
   - Shows loading skeletons in the panel
   - Fires two parallel API requests:
     fetch("/api/stops/ist-1/arrivals")
     fetch("/api/stops/ist-1/crowd")
       ↓
4. server.js: /api/stops/:id/arrivals handler
   - Finds stop in static data
   - Ensures weather is loaded for the city
   - Calls predictor.predictArrivals(stop, routes)
       ↓
5. predictor.js: predictArrivals()
   - For each route serving the stop:
     - Builds 11-feature vector from time, weather, stop profile
     - Calls arrivalModel.predict(features)
         ↓
6. arrival-model.js: predict()
   - Normalizes all features to 0-1
   - Gets prediction from all 50 trees → calculates confidence
   - Gets ensemble prediction → predicted delay
   - Generates explanation factors
   - Returns { predictedDelay, confidence, factors }
         ↓
7. predictor.js continues:
   - Computes predictedMin = scheduled + delay
   - Determines status (on-time/delayed/early)
   - Also calls crowdModel for vehicle occupancy
   - Sorts by predicted arrival time
   - Returns array to server
       ↓
8. server.js: sends JSON response
       ↓
9. app.js: receives response, calls UI.renderArrivals(arrivals)
       ↓
10. ui.js: renderArrivals()
    - Builds HTML for each arrival card
    - Identifies and tags the "Best Option"
    - Starts 15-second countdown timers
    - Animates cards in with staggered slide-up
```

The crowd flow is similar but simpler — single prediction per stop instead of per-route.

After initial render, `setInterval` repeats steps 3-10 every 30 seconds with fresh predictions.

---

## 7. Evaluation and Metrics

Both models evaluate themselves on held-out test data during training. Metrics are logged to console and available via `/api/model/info`.

### Arrival Model Evaluation

| Metric | Description | Typical Value |
|--------|-------------|---------------|
| MAE | Mean Absolute Error — average difference between predicted and actual delay | ~2.0-2.5 min |
| Within 1 min | % of predictions within 1 minute of actual | ~40-55% |
| Within 2 min | % of predictions within 2 minutes of actual | ~50-65% |
| Training time | Wall clock for 3000 samples, 50 trees | ~40-50s |

The MAE of ~2 minutes means the model's predictions are on average 2 minutes off from the "true" delay. For a transit app, this is usable — riders know the bus will arrive within a ~4 minute window of the prediction.

### Crowd Model Evaluation

| Metric | Description | Typical Value |
|--------|-------------|---------------|
| Accuracy | % of correctly classified samples | ~75-85% |
| Per-class precision | How often a predicted class is correct | Reported per class |
| Per-class recall | How often a true class is found | Reported per class |
| Training time | 2000 samples, 40 trees | ~20-25s |

A confusion matrix is computed during training:

```
              Predicted
              Low  Med  High
Actual Low  [ TP   FP   FP ]
       Med  [ FN   TP   FP ]
       High [ FN   FN   TP ]
```

The model tends to perform best on "low" and "high" extremes, with "medium" being the hardest class to distinguish (as expected — it's the middle ground).

### Why Synthetic Data

Using synthetic training data means we control the ground truth perfectly — we know exactly what factors produce what delay, so we can verify the model learns the right patterns. The tradeoff is that the model learns from our assumptions about transit dynamics, not from actual measured data. In a production system, this would be replaced with historical GTFS-realtime data or transit agency APIs.

---

## 8. Deployment

### Docker

The Dockerfile uses a multi-stage-free Alpine Node 20 image:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev          # only production dependencies
COPY . .
EXPOSE 3050
ENV NODE_ENV=production
CMD ["node", "server.js"]
```

`npm ci --omit=dev` installs exact versions from the lockfile, excluding devDependencies. The `.dockerignore` excludes `node_modules`, `.git`, and `.env` from the build context.

### Docker Compose

```yaml
services:
  app:
    build: .
    ports:
      - "3050:3050"
    environment:
      - NODE_ENV=production
      - PORT=3050
    restart: unless-stopped
```

`restart: unless-stopped` ensures the container restarts on crashes but not when explicitly stopped.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3050 | Server listen port |
| `NODE_ENV` | — | Set to `production` in Docker |

### Startup Sequence

1. Node process starts
2. `predictor.init()` trains both models (~60 seconds)
3. Express starts listening on PORT
4. App is ready at `http://localhost:3050`

The server does not accept requests until models are trained. This prevents serving predictions from uninitialized models.
