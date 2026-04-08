# PREDICTIVE TRANSIT

Real-time bus arrival prediction and stop crowd estimation for Istanbul and Ankara, powered by machine learning.

![Node.js](https://img.shields.io/badge/Node.js-20+-green) ![Express](https://img.shields.io/badge/Express-5.x-blue) ![ML](https://img.shields.io/badge/ML-Random%20Forest-purple) ![Docker](https://img.shields.io/badge/Docker-Ready-blue)

---

## Idea

Public transit riders face a core problem: **scheduled arrival times are unreliable.** Delays caused by rush hour traffic, weather, route congestion, and cascading delays make static timetables useless in practice.

**Predictive Transit** solves this by using machine learning models that factor in real-world conditions — time of day, weather, stop popularity, recent delays, route segment position — to predict:

1. **When the bus will actually arrive** (delay prediction in minutes)
2. **How crowded the stop is right now** (low / medium / high classification)

This gives riders actionable information: not just "a bus is coming" but "this bus will be 3 minutes late, the stop is moderately crowded, and there's a less crowded option in 2 minutes."

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Frontend (SPA)                     │
│  ┌──────────┐  ┌──────────┐  ┌─────────┐  ┌─────────┐  │
│  │  Map     │  │  UI      │  │  Data   │  │  App    │  │
│  │ (Leaflet)│  │ Renderer │  │ Service │  │ Control │  │
│  └──────────┘  └──────────┘  └────┬────┘  └─────────┘  │
└───────────────────────────────────┼─────────────────────┘
                                    │ REST API
┌───────────────────────────────────┼─────────────────────┐
│                    Express.js Server                    │
│                                   │                     │
│  ┌─────────────────┐  ┌──────────┴────────────┐        │
│  │  Static Data    │  │   ML Prediction Layer  │        │
│  │  (Stops/Routes) │  │  ┌─────────────────┐   │        │
│  └─────────────────┘  │  │   Predictor     │   │        │
│                       │  │  (Coordinator)   │   │        │
│  ┌─────────────────┐  │  └──┬──────────┬───┘   │        │
│  │ Weather Engine  │──│     │          │        │        │
│  └─────────────────┘  │  ┌──┴───┐  ┌───┴────┐  │        │
│                       │  │Arrival│  │ Crowd  │  │        │
│                       │  │Model  │  │ Model  │  │        │
│                       │  │(RF-R) │  │(RF-C)  │  │        │
│                       │  └──┬───┘  └───┬────┘  │        │
│                       │     │          │        │        │
│                       │  ┌──┴──────────┴────┐   │        │
│                       │  │  Data Generator  │   │        │
│                       │  │(Synthetic Train) │   │        │
│                       │  └──────────────────┘   │        │
│                       └─────────────────────────┘        │
└──────────────────────────────────────────────────────────┘
```

**Components:**

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | Vanilla JS + Leaflet.js | Interactive dark-themed map with stop markers, search, live countdown timers |
| API Server | Express.js 5 | REST endpoints for stops, routes, arrivals, crowd, weather, model info |
| Arrival Model | `ml-random-forest` (RandomForestRegression) | Predicts bus delay in minutes given 11 features |
| Crowd Model | `ml-random-forest` (RandomForestClassifier) | Classifies stop crowd level (low/medium/high) given 9 features |
| Data Generator | Custom synthetic engine | Generates realistic training data encoding Istanbul/Ankara transit patterns |

---

## Prediction Method

### Arrival Delay Prediction (Regression)

**Model:** Random Forest Regressor with 50 decision trees

**Features (11):**

| # | Feature | Normalization | Why it matters |
|---|---------|---------------|----------------|
| 1 | Hour of day | /23 | Rush hour vs. off-peak |
| 2 | Day of week | /6 | Weekday vs. weekend patterns |
| 3 | Is rush hour | binary | Peak congestion flag |
| 4 | Temperature | /40 | Icy conditions slow traffic |
| 5 | Precipitation | /80 | Rain causes delays |
| 6 | Wind speed | /45 | Storm conditions |
| 7 | Scheduled minutes | /30 | Longer routes accumulate delay |
| 8 | Stop popularity | 0-1 | Busy stops = more dwell time |
| 9 | Route avg delay | /4 | Historical route performance |
| 10 | Recent delay | /8 | Cascading delay propagation |
| 11 | Segment index | /10 | Further stops = more accumulated delay |

**Target:** Delay in minutes (positive = late, negative = early, clamped to [-3, +15])

**Confidence scoring:** Each of the 50 trees independently predicts the delay. Confidence is derived from the inverse of the standard deviation across tree predictions — low variance = high confidence.

### Crowd Level Estimation (Classification)

**Model:** Random Forest Classifier with 40 decision trees

**Features (9):** Hour, day, rush hour flag, temperature, precipitation, wind, current delay, route frequency, stop popularity

**Classes:** Low (< 25 crowd score) | Medium (25-55) | High (> 55)

**Confidence:** Tree voting — percentage of trees agreeing on the majority class. Full probability distribution is returned (e.g., Low 15%, Medium 60%, High 25%).

### Training Data

Both models train on **synthetic data** generated by a custom engine that encodes real-world Istanbul and Ankara transit patterns:

- 15 stop profiles with realistic popularity and delay characteristics (e.g., Taksim = 0.95 popularity, Sultanahmet = tourist zone congestion)
- Rush hour effects (+2-6 min delay)
- Weather effects (rain +1.5-4.5 min, storms +2-5 min, ice +0.5-1.5 min)
- Weekend reduction (30-70% of weekday delays)
- Delay propagation (recent delays cascade at 30-70%)
- Gaussian noise for realistic variance

---

## Evaluation Results

Models are evaluated on held-out test sets at startup:

### Arrival Model
| Metric | Value |
|--------|-------|
| Training samples | 3,000 |
| Test samples | 500 |
| **Mean Absolute Error (MAE)** | **~1.0-1.5 min** |
| Predictions within 1 min | ~55-65% |
| Predictions within 2 min | ~80-90% |

### Crowd Model
| Metric | Value |
|--------|-------|
| Training samples | 2,000 |
| Test samples | 400 |
| **Overall Accuracy** | **~80-90%** |
| Per-class precision/recall | Reported at startup |

> Exact metrics vary per run due to random seed in data generation. Check live metrics at `GET /api/model/info`.

---

## Quick Start

### Run with Node.js
```bash
npm install
npm start
# Open http://localhost:3000
```

### Run with Docker
```bash
docker build -t predictive-transit .
docker run -p 3000:3000 predictive-transit
```

### Run with Docker Compose
```bash
docker compose up --build
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stops` | All stops (optional `?city=Istanbul`) |
| GET | `/api/stops/:id` | Single stop details |
| GET | `/api/stops/:id/arrivals` | **ML-predicted arrivals** for a stop |
| GET | `/api/stops/:id/crowd` | **ML-predicted crowd level** for a stop |
| GET | `/api/routes` | All routes (optional `?city=Ankara`) |
| GET | `/api/weather` | Current weather (`?city=Istanbul`) |
| GET | `/api/model/info` | ML model training metrics and status |

A **Postman collection** is included: import `postman-collection.json` into Postman to test all endpoints.

### Example Response: Arrival Prediction

```json
{
  "routeId": "T1",
  "routeName": "T1 Kabatas-Bagcilar",
  "predictedMin": 7,
  "delayMin": 2.3,
  "status": "delayed",
  "confidence": 84,
  "occupancy": "medium",
  "factors": [
    { "icon": "🕐", "label": "Rush hour", "impact": "+2-5 min", "type": "negative" },
    { "icon": "🌧️", "label": "Rain", "impact": "+2-4 min", "type": "negative" }
  ],
  "mlPowered": true
}
```

### Example Response: Crowd Prediction

```json
{
  "level": "medium",
  "estimatedCount": 18,
  "confidence": 72,
  "probabilities": { "low": 15.0, "medium": 72.5, "high": 12.5 },
  "reason": "Rush hour congestion, rain increasing transit demand",
  "trend": "rising",
  "mlPowered": true
}
```

---

## Project Structure

```
RouteProject/
├── server.js                 # Express API server + static serving
├── ml/
│   ├── arrival-model.js      # Random Forest Regressor (delay prediction)
│   ├── crowd-model.js        # Random Forest Classifier (crowd estimation)
│   ├── predictor.js          # Prediction coordinator
│   └── data-generator.js     # Synthetic training data engine
├── public/
│   ├── index.html            # SPA entry point
│   ├── css/
│   │   ├── variables.css     # Design tokens
│   │   ├── base.css          # Reset + utilities
│   │   └── components.css    # All UI components
│   └── js/
│       ├── app.js            # App controller
│       ├── data.js           # API data service
│       ├── map.js            # Leaflet map controller
│       └── ui.js             # UI renderer
├── Dockerfile                # Container build
├── docker-compose.yml        # One-command deploy
├── postman-collection.json   # API test collection
└── package.json
```

---

## MVP Demo Scenario

1. **Open the app** at `http://localhost:3000`
2. **Select a city** (Istanbul / Ankara toggle)
3. **Click any bus stop** on the map (or search by name)
4. **See ML-predicted arrivals**: delay, confidence bar, interpretable factors (rush hour, rain, etc.), recommended best option
5. **See ML-predicted crowd**: level with probability distribution, estimated count, trend direction, human-readable reason
6. **Auto-refresh** every 30 seconds with updated predictions
7. **Check model metrics** via the footer or `/api/model/info`
