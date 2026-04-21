# PREDICTIVE TRANSIT

**When will my bus actually arrive — and should I even take it?**

Riders don't trust static timetables because delays, crowding, and rainy days break them. This app predicts real arrival times for Sivas buses using the hackathon dataset, classifies how crowded each bus will be on a 5-level scale, and — crucially — turns those predictions into a single 1-second decision: **run, wait, board, or take an alternative.** Built for the 2026 Predictive Transit hackathon.

> **📘 Full ML documentation & measured metrics: [ML.md](ML.md)** — architecture, feature lists, training data, per-class precision/recall, confidence-band math, and the rationale behind every modelling choice. **Judges should start here.**

![Node.js](https://img.shields.io/badge/Node.js-20+-green) ![MySQL](https://img.shields.io/badge/MySQL-8.0-blue) ![ML](https://img.shields.io/badge/ML-Random%20Forest-purple) ![Data](https://img.shields.io/badge/Data-Real%20Sivas-orange) ![Docker](https://img.shields.io/badge/Docker-Ready-blue) ![Tests](https://img.shields.io/badge/Tests-53%20passing-brightgreen)

### Measured performance — [ML.md](ML.md)

| Model | Metric | Value |
|---|---|---|
| Arrival (RF Regressor) | MAE | **~2.0 min** |
| Arrival | Within 2 min | **70.5 %** |
| Crowd (RF Classifier, 5-class) | Accuracy | **99.9 %** |
| Live inference | Latency | **~1 ms / prediction** |
| `/advice` endpoint | End-to-end | **20–80 ms** |

### 📱 Responsive & mobile-first

The UI is **designed primarily for mobile riders** — the people actually standing at a bus stop trying to decide whether to run. The full app is fully responsive from 320 px phones up through desktop:

- **Mobile (≤ 860 px):** map on top, advice panel below with a **drag handle** you can pull up to resize the split, plus a **full-size toggle** that expands the panel to the whole screen. Touch, pointer, and mouse events are all supported (tested on iPhone 12 emulation and real devices).
- **Tablet / desktop:** side-by-side layout with a fixed advice panel and a full-viewport map.
- **Dark / light theme:** auto-detects `prefers-color-scheme`, persists user choice, and runs a pre-paint bootstrap so there's no light-to-dark flash on reload.
- **Everything is reachable with one thumb** — drag handle, full-size button, search, city toggle, theme toggle, and every advice chip.

A desktop experience on mobile is a demo, not a product. This is the other way round.

---

## Quick Start

```bash
docker compose up -d --build

# optional
docker compose logs -f app # to see logs

docker compose down # if you want to stop
# Open http://localhost:3050 → select Sivas → click any bus stop
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
| **ETA confidence band** | Std-dev across the 50 RF tree predictions × 1.28 ≈ 80% CI | `± X min · Y%` | "How certain is that number?" |
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

## Beyond the Advice Card

Four features extend the base product into a full navigation app:

### 🗺️ Multi-Modal Journey Planner (`/api/journey`)
Dijkstra over a transit graph (bus edges + walking transfers + dolmus fallback), producing leg-by-leg plans like `Walk 180m (2 min) → L03 at 09:12 → ride 14 min → walk 90m (1 min)`. Walk legs are routed through **OSRM** (public `router.project-osrm.org/foot` server, 1.5s timeout, 500-entry LRU cache, silent haversine fallback) so the map shows real sidewalks, not straight lines. Module: [ml/journey.js](ml/journey.js).

### 🎯 ETA Confidence Bands
Each Random Forest produces 50 tree predictions. The spread between them is the model's own uncertainty. We expose that as `stddev` in [ml/arrival-model.js](ml/arrival-model.js#L138-L145), convert it to a minute-band via `round(stddev × 1.28)` (≈ 80% CI assuming near-normal residuals), and render it under every countdown: **"4 min · ± 2 min · 84%"**. Built to deepen trust — riders see when the model is hedging vs. confident.

### 📉 Delay Cascade (`/api/cascade`)
Predicts how delay snowballs downstream along a line using `cumulative_delay_min` history per `(route, stop_sequence)`. Renders a green → red gradient polyline on the map plus a side-panel summary card showing delay at each stop. L01 is the demo-winning route — delay grows from ~1 min at stop 1 to ~15 min by stop 13. Module: [ml/cascade.js](ml/cascade.js).

### 🚌 Live Bus Positions (`/api/live-buses`)
For every trip active right now (matched on DOW + time window in `hackathon_trips`), we estimate its position by interpolating along the ordered stop sequence with the RF's predicted delay applied. Frontend polls every 4 s; `requestAnimationFrame`-tweened markers slide smoothly without fighting Leaflet's own pan transforms. **No GPS** — it's schedule + ML delay, and we call that out in the UI. Module: [ml/live.js](ml/live.js).

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
 │ MAE ~1.85 min  │      │ 5-class, 100%  │      │ stress + seat  │
 │ 11 features    │      │ 9 features     │      │ turnover + rec │
 └────────┬───────┘      └────────┬───────┘      └────────┬───────┘
          └───────────────────────┼───────────────────────┘
                                  ▼
                       ┌───────────────────────┐
                       │   Express 5 API       │
                       │ gzip + helmet + cache │
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
| `GET /api/stops/:id/advice` | **Full advice payload**: ML arrivals + stress + seats + recommendations + `etaBandMin` |
| `GET /api/stops/:id/arrivals` | Raw arrival predictions only |
| `GET /api/stops/:id/crowd` | Stop-level crowd classification |
| `GET /api/journey?from=X&to=Y` | **Multi-modal journey**: Dijkstra over bus edges + OSRM-routed walk legs |
| `GET /api/cascade?routeId=X&fromStopId=Y` | Delay propagation along a route — map gradient + per-stop delay |
| `GET /api/live-buses` | Live-position estimate for every active trip (schedule + ML delay) |
| `GET /api/stops?city=Sivas` | All Sivas stops with routes |
| `GET /api/routes?city=Sivas` | All 5 Sivas routes |
| `GET /api/weather?city=Sivas` | Seeded weather (from trip averages) |
| `GET /api/model/info` | Model metrics, data source, feature list |
| `GET /api/hackathon/stats` | Row counts, data load status |
| `GET /api/health` | Server status, uptime, memory usage |

All API responses include `X-Response-Time` header for performance monitoring.
Import `postman-collection.json` for ready-to-use requests.

---

## Data & Models

- **Data source:** `hackathon_real` — 62 Sivas stops across 5 lines (L01–L05), 13,440 trips, 4,478 per-stop arrival observations, 3,568 passenger-flow aggregates.
- **Arrival model:** Random Forest Regressor, 50 estimators, 11 features (hour, dayOfWeek, isRushHour, temperature, precipitation, windSpeed, scheduledMinutes, stopPopularity, routeAvgDelay, recentDelay, segmentIndex). **MAE: ~1.85 min. Within 2 min: ~70%.**
- **Crowd model:** Random Forest Classifier, 50 estimators, 9 features, **5-class** (empty / light / moderate / busy / crowded). Accuracy: 100% on hold-out set.
- **Determinism:** `/advice` output is byte-stable within the current minute. Scheduled departures, recent delays, trip IDs, occupancy %, and speed factor all come from the DB; weather is seeded once from trip averages at startup. No `Math.random()` in the Sivas prediction path.

### Performance Optimizations

- **Batch SQL queries** — schedule lookups reduced from 25 to 3 round-trips per advice request
- **gzip compression** — all JSON responses compressed ~60-70%
- **Composite DB indexes** — `(stop_id, line_id, scheduled_arrival)` for fast lookups
- **ML single-pass** — prediction + confidence computed in one forest traversal (was 2×)
- **Static asset caching** — 1-hour max-age + ETag
- **Parallel init** — map tiles load while API call is in flight
- **CDN preconnect** — CARTO tile DNS/TLS resolved during HTML parse

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
  js/data.js                 API client (with error handling)
  js/map.js                  Leaflet map
  css/                       Design tokens + component styles
test/
  predictor.helpers.test.js  15 unit tests
  advisor.helpers.test.js    34 unit tests
  integration.live.test.js   4 integration tests
Given Data by hackathon team/ Raw Sivas CSVs
docker-compose.yml           App + MySQL stack
PROJECT_OVERVIEW.md          Jury-ready project document (Turkish)
DOCUMENTATION.md             Deep technical reference
```

---

## Tech Stack

- **Runtime:** Node.js 20 + Express 5
- **Database:** MySQL 8 (via mysql2, keepAlive enabled)
- **ML:** `ml-random-forest` (Random Forest Regression + Classification)
- **Security:** helmet.js (automatic security headers)
- **Performance:** compression (gzip), batch SQL, composite indexes
- **Frontend:** Vanilla JS modules, Leaflet.js (OSM + CARTO dark tiles)
- **Testing:** 53 tests via `node:test` (zero dependency test runner)
- **Deploy:** Docker Compose (app + db)

---

## Testing

```bash
npm test                     # All 53 tests (unit + integration)
npm run test:unit            # Unit tests only (no server needed)
npm run test:integration     # Integration tests (server must be running)
```

---

## Documentation

- **[HANDOFF.md](HANDOFF.md)** — 2-minute context brief for a new contributor (or a fresh AI session): goals, deadlines, what's built, known quirks, open work.
- **[DOCUMENTATION.md](DOCUMENTATION.md)** — Deeper technical breakdown of the models, features, and data pipeline.
