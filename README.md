# PREDICTIVE TRANSIT

ML-powered bus arrival prediction and stop crowd estimation for Istanbul and Ankara.

Riders don't trust static timetables because delays are constant. This app predicts **when your bus will actually arrive** and **how crowded your stop is**, using Random Forest models that factor in time of day, weather, route congestion, and cascading delays.

![Node.js](https://img.shields.io/badge/Node.js-20+-green) ![Express](https://img.shields.io/badge/Express-5.x-blue) ![ML](https://img.shields.io/badge/ML-Random%20Forest-purple) ![Docker](https://img.shields.io/badge/Docker-Ready-blue)

---

## Quick Start

```bash
# Node.js
npm install
npm start

# Docker
docker compose up --build

# Then open http://localhost:3000
```

Models train on startup (~60s). Once ready, click any stop on the map to see predictions.

---

## What It Does

**Arrival Prediction** — For each bus serving a stop, the system predicts delay in minutes using 11 features (hour, weather, stop popularity, recent delays, route segment). Each prediction comes with a confidence score and human-readable explanation factors like "Rush hour +2-5 min" or "Rain +2-4 min". The best option (on-time + low crowd) is auto-highlighted.

**Crowd Estimation** — Classifies each stop as low / medium / high crowd. Returns estimated passenger count, probability distribution across all three classes, trend direction (rising/stable/falling), and a plain-text reason. Example: "Rush hour congestion, rain increasing transit demand".

Both models retrain from scratch on startup using synthetic data that encodes real Istanbul/Ankara transit patterns (15 stop profiles, rush hour effects, weather impacts, delay propagation).

---

## API

| Endpoint | What it returns |
|----------|----------------|
| `GET /api/stops?city=Istanbul` | All stops (filterable by city) |
| `GET /api/stops/:id` | Single stop details |
| `GET /api/stops/:id/arrivals` | ML-predicted arrivals with delay, confidence, factors |
| `GET /api/stops/:id/crowd` | ML-predicted crowd level, count, probabilities, trend |
| `GET /api/routes?city=Ankara` | All routes (filterable by city) |
| `GET /api/weather?city=Istanbul` | Current weather conditions |
| `GET /api/model/info` | Model metrics: MAE, accuracy, sample counts |

Import `postman-collection.json` into Postman for ready-to-use requests.

<details>
<summary>Example: Arrival Prediction Response</summary>

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
</details>

<details>
<summary>Example: Crowd Prediction Response</summary>

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
</details>

---

## Project Structure

```
server.js                 → Express API + static file serving
ml/
  arrival-model.js        → Random Forest Regressor (bus delay)
  crowd-model.js          → Random Forest Classifier (stop crowd)
  predictor.js            → Coordinates both models
  data-generator.js       → Synthetic training data engine
public/
  index.html              → Single-page app shell
  js/app.js               → App controller (city switching, stop selection, auto-refresh)
  js/map.js               → Leaflet map (dark tiles, markers, route polylines)
  js/ui.js                → UI renderer (arrival cards, crowd card, weather)
  js/data.js              → Fetch wrapper for all API calls
  css/                    → Design tokens, reset, all component styles
Dockerfile                → Alpine Node 20 production image
docker-compose.yml        → One-command deploy
postman-collection.json   → All API endpoints for Postman
DOCUMENTATION.md          → Detailed technical documentation
```

---

## Tech Stack

- **Runtime:** Node.js 20 + Express 5
- **ML:** ml-random-forest (Random Forest Regression + Classification)
- **Frontend:** Vanilla JS, Leaflet.js (OpenStreetMap + CARTO dark tiles)
- **Deploy:** Docker / Docker Compose

---

## Documentation

See [DOCUMENTATION.md](DOCUMENTATION.md) for the full technical breakdown — architecture, how the models work, feature engineering, training data generation, confidence scoring, evaluation metrics, and how each component connects.
