# PREDICTIVE TRANSIT

**When will my bus actually arrive — and should I even take it?**

Riders don't trust static timetables because delays, crowding, and rainy days break them. This app predicts real arrival times for Sivas buses using the hackathon dataset, classifies how crowded each bus will be on a 5-level scale, and — crucially — turns those predictions into a single 1-second decision: **run, wait, board, or take an alternative.** Built for the 2026 Predictive Transit hackathon.

![Node.js](https://img.shields.io/badge/Node.js-20+-green) ![MySQL](https://img.shields.io/badge/MySQL-8.0-blue) ![ML](https://img.shields.io/badge/ML-Random%20Forest-purple) ![Data](https://img.shields.io/badge/Data-Real%20Sivas-orange) ![Docker](https://img.shields.io/badge/Docker-Ready-blue)

---

## Quick Start

```bash
docker compose up -d --build
# Open http://localhost:3000 → select Sivas → click any bus stop
```

First startup loads 62 Sivas stops, 13k trips, 4.4k arrival observations, and 3.5k passenger-flow records into MySQL, then trains both ML models on the real data (~2 minutes total).

---

## What the Rider Sees

Every bus at a selected stop shows up as an **advice card** with one hero takeaway and four supporting metrics:

```
┌─────────────────────────────────────────────────┐
│ ⭐ EN İYİ SEÇENEK                               │
│                                                 │
│ L01  → Merkez - Üniversitesi        [4 dk]     │
│       🧠 ML · TRP-04565                         │
│                                                 │
│ Yoğunluk   Doluluk       Koltuk   Stres         │
│ crowded    ████░░ 83%    🪑 10    57 · Yoğun    │
│                                                 │
│ ✅ On Time · Planlanan: 3dk · Sonraki: 12dk     │
│ 🪑 Biraz koltuk değişimi var — 7 kişi inecek    │
│                                                 │
│ ⏳  6 dk bekle — sonraki otobüs daha boş (%58)  │
└─────────────────────────────────────────────────┘
```

The big number and the recommendation chip are the **1-second read**. Everything else is secondary detail for riders who want it.

---

## The Advice Engine — What Each Signal Means

| Signal | Source | Range | What it answers |
|---|---|---|---|
| **Countdown** | Random Forest regressor on scheduled time + real delays + weather + segment | minutes | "How long until it gets here?" |
| **Yoğunluk** (crowd level) | Real `avg_occupancy_pct` from `hackathon_trips`, classified into 5 bands | empty / light / moderate / busy / crowded | "How packed is this bus?" |
| **Doluluk** (occupancy %) | Same real trip average | 0–100 % | Exact fill level |
| **Koltuk** (seats) | `bus_capacity × (1 − occupancy)` | integer | "Will I get a seat?" |
| **Stres** (stress score) | Composite: occupancy + delay + rush hour + remaining stops + speed factor | 0–100 (Rahat / Normal / Yoğun / Stresli) | "How unpleasant will this ride be?" |
| **Seat turnover** | Avg `passengers_alighting` at the next 3 stops | very low → high | "Will a seat free up soon?" |
| **Recommendation chip** | Rule-based advisor over all of the above + next-bus schedule | one action | **The 1-second answer** |

### Possible recommendation actions

| Icon | Action | When it fires |
|---|---|---|
| 🏃 | **Run** — "Otobüs 1 dk'ya kalkıyor" | Bus arriving in ≤2 min |
| ⚠️ | **Last bus** — "Son sefer — bu gece başka otobüs yok" | After 21:00 and no more trips on this line tonight |
| ⏳ | **Wait** — "6 dk bekle, sonraki otobüs daha boş (%45)" | Next bus is ≤12 min away and ≥20 pp emptier |
| 🪑 | **Board (turnover hint)** — "Koltuklar 3 durakta boşalacak" | Packed now but high alighting ahead |
| 🔄 | **Alternative** — "İlk durağa git — boş otobüse bin (2 durak geri)" | Long ride, high occupancy, terminal stop nearby |
| ✅ | **Board** — "Bin — stres seviyesi düşük" | Default: stress score < 50 |
| 😤 | **Board** — "Kalabalık ama alternatifsiz — bin" | High stress but no better option |

---

## Architecture

```
                       ┌───────────────────────┐
                       │   Sivas Hackathon CSV │
                       │  62 stops · 13k trips │
                       │  4.4k arrivals · flow │
                       └──────────┬────────────┘
                                  │ db/load-csv.js
                                  ▼
                       ┌───────────────────────┐
                       │       MySQL 8         │
                       │  hackathon_trips      │
                       │  hackathon_arrivals   │
                       │  hackathon_pass_flow  │
                       │  stops · routes · ... │
                       └──────────┬────────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          ▼                       ▼                       ▼
 ┌────────────────┐      ┌────────────────┐      ┌────────────────┐
 │ Arrival Model  │      │  Crowd Model   │      │   Advisor      │
 │ RF Regressor   │      │ RF Classifier  │      │  (rule-based)  │
 │ MAE 2.07 min   │      │ 5-class, 100%  │      │ stress + seat  │
 │ 11 features    │      │ 9 features     │      │ turnover + rec │
 └────────┬───────┘      └────────┬───────┘      └────────┬───────┘
          └───────────────────────┼───────────────────────┘
                                  ▼
                       ┌───────────────────────┐
                       │   Express API         │
                       │ /api/stops/:id/advice │
                       └──────────┬────────────┘
                                  ▼
                       ┌───────────────────────┐
                       │   Vanilla JS + Leaflet│
                       │   Advice Cards UI     │
                       └───────────────────────┘
```

---

## API

The hero endpoint is `/api/stops/:id/advice`. Everything else is supporting.

| Endpoint | Returns |
|---|---|
| `GET /api/stops/:id/advice` | **Full advice payload**: ML arrivals + stress + seats + recommendations |
| `GET /api/stops/:id/arrivals` | Raw arrival predictions only |
| `GET /api/stops/:id/crowd` | Stop-level crowd classification |
| `GET /api/stops?city=Sivas` | All Sivas stops with routes |
| `GET /api/routes?city=Sivas` | All 5 Sivas routes |
| `GET /api/weather?city=Sivas` | Seeded weather (from trip averages) |
| `GET /api/model/info` | Model metrics, data source, feature list |
| `GET /api/hackathon/stats` | Row counts, data load status |

Import `postman-collection.json` for ready-to-use requests.

---

## Data & Models

- **Data source:** `hackathon_real` — 62 Sivas stops across 5 lines (L01–L05), 13,440 trips, 4,478 per-stop arrival observations, 3,568 passenger-flow aggregates.
- **Arrival model:** Random Forest Regressor, 50 estimators, 11 features (hour, dayOfWeek, isRushHour, temperature, precipitation, windSpeed, scheduledMinutes, stopPopularity, routeAvgDelay, recentDelay, segmentIndex). **MAE: 2.07 min. Within 2 min: 69.4%.**
- **Crowd model:** Random Forest Classifier, 50 estimators, 9 features, **5-class** (empty / light / moderate / busy / crowded). Accuracy: 100% on hold-out set (caveat: `empty` class underrepresented — 0 samples in training set).
- **Determinism:** `/advice` output is byte-stable within the current minute. Scheduled departures, recent delays, trip IDs, occupancy %, and speed factor all come from the DB; weather is seeded once from trip averages at startup. No `Math.random()` in the Sivas prediction path.

---

## Project Structure

```
server.js                    Express API, all routes, startup
db/
  init.js                    Schema + seed + Sivas backfill
  load-csv.js                Hackathon CSV loader + weather seeding
  connection.js              MySQL pool
ml/
  predictor.js               Arrival/crowd orchestration + real-schedule lookup
  advisor.js                 Stress, seat turnover, recommendation chips
  arrival-model.js           Random Forest Regressor
  crowd-model.js             Random Forest Classifier (5-class)
  data-generator.js          Synthetic fallback + real dataset loaders
public/
  index.html                 SPA shell
  js/app.js                  Controller: city/stop selection, auto-refresh
  js/ui.js                   Advice cards, crowd card, renderers
  js/data.js                 API client
  js/map.js                  Leaflet map
  css/                       Design tokens + component styles
Given Data by hackathon team/ Raw Sivas CSVs
docker-compose.yml           App + MySQL stack
HANDOFF.md                   Context brief for new contributors / AI sessions
DOCUMENTATION.md             Deep technical reference
```

---

## Tech Stack

- **Runtime:** Node.js 20 + Express 5
- **Database:** MySQL 8 (via mysql2)
- **ML:** `ml-random-forest` (Random Forest Regression + Classification)
- **Frontend:** Vanilla JS modules, Leaflet.js (OSM + CARTO dark tiles)
- **Deploy:** Docker Compose (app + db)

---

## Documentation

- **[HANDOFF.md](HANDOFF.md)** — 2-minute context brief for a new contributor (or a fresh AI session): goals, deadlines, what's built, known quirks, open work.
- **[DOCUMENTATION.md](DOCUMENTATION.md)** — Deeper technical breakdown of the models, features, and data pipeline.
