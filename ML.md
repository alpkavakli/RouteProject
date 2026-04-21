# Route Albatros — ML Architecture & Metrics

This document explains every ML/statistical component in the app, how they were trained on the hackathon's real Sivas dataset, and the measured performance of each model on held-out data.

> **TL;DR** — Two Random Forests (arrival delay regressor + 5-class crowd classifier) are trained on real hackathon data at startup and then orchestrated with historical priors, a Dijkstra journey planner, a statistical delay-cascade projector, and a rule-based advisor to produce a **single 1-second decision per bus**: run, wait, board, or take an alternative.
>
> **Measured on held-out Sivas data:** arrival MAE **2.0 min**, 70.5 % of predictions within ±2 min; crowd classifier **99.9 %** accuracy across 5 classes.

---

## 1. The two trained models at a glance

| | Arrival Delay Model | Crowd Model |
|---|---|---|
| Algorithm | Random Forest Regression | Random Forest Classification |
| Library | `ml-random-forest` | `ml-random-forest` |
| Trees | 50 | 50 |
| `maxFeatures` | 0.7 (≈ 7 of 11 per split) | 0.7 (≈ 6 of 9 per split) |
| Bagging | `useSampleBagging: true`, `replacement: true`, `seed: 42` | same |
| Features | 11 | 9 |
| Output | `delayMin` (continuous) + ensemble std-dev | one of `empty / light / moderate / busy / crowded` |
| Training samples | **3,582** | **2,854** |
| Test samples | **896** | **714** |
| Training time (cold) | ~61.5 s | ~57.5 s |
| Persistence | Serialized JSON at `ml/cache/arrival-model.json` | `ml/cache/crowd-model.json` |
| File | [ml/arrival-model.js](ml/arrival-model.js) | [ml/crowd-model.js](ml/crowd-model.js) |

Both models are retrained on startup if cache is absent; otherwise loaded from disk (sub-second). Numbers above come from the live API at `GET /api/model/info` — no hand-curated figures.

---

## 2. Arrival Delay Model

### 2.1 What it predicts
For a given `(lineId, stopId, scheduledTime, weather, recentObservations)`, it predicts **delay in minutes** relative to the published schedule. Countdown on the UI = scheduled ETA + predicted delay.

### 2.2 Features (11)

| # | Feature | Why it matters |
|---|---|---|
| 1 | `hour` (0–23, normalized) | Rush-hour traffic pattern |
| 2 | `dayOfWeek` (Mon=0 … Sun=6) | Weekday vs. weekend |
| 3 | `isRushHour` (0/1) | Explicit rush flag the model doesn't have to rediscover from hour |
| 4 | `temperature` (°C, normalized) | Heat/cold affects speed and dwell |
| 5 | `precipitation` (mm, normalized) | Rain → longer dwell + slower driving |
| 6 | `windSpeed` (km/h, normalized) | Extreme wind correlates with delays in the data |
| 7 | `scheduledMinutes` | Schedule offset — longer trips accumulate more drift |
| 8 | `stopPopularity` (0–1) | High-traffic stops take longer to board |
| 9 | `routeAvgDelay` | Line-specific baseline chronic lateness |
| 10 | `recentDelay` | Current network state — if the last 3 buses were late, the next probably is too |
| 11 | `segmentIndex` (0–1) | Position of this stop along the route — delays compound downstream |

All features are normalized in `[0, 1]` at inference time (see `features = [...]` block in [ml/arrival-model.js:110-121](ml/arrival-model.js#L110-L121)).

### 2.3 Training data
Built by joining `hackathon_arrivals` (per-stop observations with `delay_min`) to `hackathon_trips` (the scheduled plan + weather + occupancy):

```
SELECT a.*, t.temperature_c, t.precipitation_mm, t.wind_speed_kmh,
       t.day_of_week, t.planned_duration_min, t.avg_occupancy_pct
  FROM hackathon_arrivals a
  JOIN hackathon_trips t ON a.trip_id = t.trip_id
 WHERE a.delay_min IS NOT NULL
```

4,478 raw arrival rows, cleaned and stratified 80/20 → **3,582 train / 896 test**.

### 2.4 Measured performance (hackathon_real, held-out 20 %)

| Metric | Value |
|---|---|
| MAE | **~2.0 min** |
| Within 1 minute | **43.1 %** |
| Within 2 minutes | **70.5 %** |
| Within 3 minutes | ~85 % |
| Training time | 61.5 s |
| Inference | ~1 ms per prediction |

For context: Sivas buses average ~3.2 min of chronic delay with a std-dev of ~4 min, so MAE 2.0 min means we explain a solid chunk of the variance. The model was validated against a synthetic fallback dataset first, but every metric quoted in README/UI is from the real-data path.

### 2.5 ETA confidence bands (no extra model)
A Random Forest is 50 independent tree predictions — their spread *is* a cheap ensemble uncertainty estimate. We compute both the mean and std-dev in a single pass ([ml/arrival-model.js:125-132](ml/arrival-model.js#L125-L132)):

```js
const treePredictions = model.estimators.map(tree => tree.predict([features])[0]);
const predictedDelay = mean(treePredictions);
const stddev = Math.sqrt(variance(treePredictions, predictedDelay));
```

The UI renders **`round(stddev × 1.28)`** as an "80 % CI" band. Tight agreement across trees → narrow band → "high confidence"; disagreement → wider band → a visible hedge the rider can see. A minimum floor of 0.4 is enforced so even unanimous forests show some band.

---

## 3. Crowd Model (5-class)

### 3.1 What it predicts
Classifies the expected occupancy of an arriving bus into one of five buckets:

| Class | Occupancy % | UI colour |
|---|---|---|
| `empty`    | < 15 %   | green |
| `light`    | 15–35 %  | light-green |
| `moderate` | 35–60 %  | yellow |
| `busy`     | 60–80 %  | orange |
| `crowded`  | ≥ 80 %   | red |

Note: whenever `avg_occupancy_pct` is present on a `hackathon_trips` row, we use that real number directly and the classifier becomes a fallback — so on seen trips the app reports ground-truth crowd. The classifier is what turns 9 contextual features into a crowd guess when only the schedule is known (e.g. future times).

### 3.2 Features (9)

| # | Feature |
|---|---|
| 1 | `hour` |
| 2 | `dayOfWeek` |
| 3 | `isRushHour` |
| 4 | `temperature` |
| 5 | `precipitation` |
| 6 | `windSpeed` |
| 7 | `currentDelay` (delayed buses are often fuller — they skip fewer riders) |
| 8 | `routeFrequency` (a bus every 5 min is emptier than every 20 min) |
| 9 | `stopPopularity` |

### 3.3 Measured performance

| | Precision | Recall |
|---|---|---|
| `empty` | 100 % | 50 % |
| `light` | 99.2 % | 100 % |
| `moderate` | 100 % | 100 % |
| `busy` | 100 % | 100 % |
| `crowded` | 100 % | 100 % |
| **Overall accuracy** | **99.9 %** on 714 held-out samples | |

> **Reading the empty/light numbers honestly.** There are very few truly `empty` trips in Sivas data (the buckets `empty/light` together are the minority class). Recall drops to 50 % on `empty` mainly because borderline `empty` trips (occupancy 13–15 %) get classified as `light`, which is the correct boundary — but still counts as a miss. Every other class is essentially solved. We call this out rather than hide it.

---

## 4. Historical priors — the tensor that covers "future time" queries

Live `recentDelay` only exists for *now*. If a rider says "show me buses at 17:30 on Friday", there is no live signal — just the schedule and the weather. To serve those queries without fabricating state, we precompute two priors tables at startup ([ml/predictor.js:25-74](ml/predictor.js#L25-L74)):

```
delayByLineHourDow[lineId | hour | dayOfWeek] → avg delay  (383 cells)
weatherByHourDow[hour | dayOfWeek]            → {temp, precip, wind} (126 cells)
```

At prediction time, the service routes the request:

| When is the rider asking about? | What feeds the model |
|---|---|
| Next 120 min, same day | Live schedule + live delay + live weather |
| Later today / same week | Historical priors for that `(line, hour, dow)` cell |
| Next week+ | Historical priors with a confidence tier downgrade in the response |

This is why the UI can answer "what will the 17:30 bus be like next Thursday?" without hallucinating a `recentDelay`.

---

## 5. Delay Cascade — statistical, not ML

[ml/cascade.js](ml/cascade.js) projects how a delay at one stop will snowball downstream. It is intentionally **not** a trained model — with 4.4 k arrivals split across 62 stops × 5 lines × hour-of-day, the per-cell sample size is too small to train reliably. Instead we compute:

1. **Baseline cumulative delay** per `(routeId, stop_sequence)` — what is typical on this route at this point.
2. **Excess delay at origin** — current minus baseline at the stop the rider is at.
3. **Projection** — add excess to baseline at each downstream stop.
4. **Severity bucket**: `< 3 low / < 7 moderate / < 12 high / < 20 severe / ≥ 20 critical`.

Renders a green→red gradient along the route polyline on the map plus a side-panel card. Simple, robust, and obviously correct — a deliberate choice over a fragile neural net.

---

## 6. Journey Planner — Dijkstra over a hybrid graph

[ml/journey.js](ml/journey.js). Not ML, but core to the product.

```
Graph nodes:  bus stops
Graph edges:  (a) bus edge   — consecutive stops on the same line, weighted
                               by AVG_MIN_PER_SEGMENT × segments + TRANSFER_PENALTY
              (b) walk edge  — any two stops within NATURAL_TRANSFER_M = 2000 m
                               at WALK_SPEED_M_MIN = 83.3 (5 km/h)
              (c) dolmus     — fallback minibus/taxi at DOLMUS_SPEED_M_MIN = 333 (20 km/h)

Output:       leg-by-leg plan: [{ type: bus|walk|dolmus, ...duration, ...path }]
```

Walking legs are routed through the **OSRM public demo server** (`router.project-osrm.org/foot`, 1.5 s timeout, 500-entry LRU cache) so the map shows real sidewalks and bridges, not straight geodesic lines. If OSRM is unavailable we silently fall back to haversine × 1.2 (a typical detour factor). OSRM's public demo returns car-speed durations even with the `foot` profile — we recompute `distance / WALK_SPEED_M_MIN` ourselves to avoid that bug.

Three-tier fallback inside the planner:
1. Dijkstra over the full graph.
2. `buildForcedTransferPath` — explicit transfer at a hub even if the greedy path missed it.
3. `buildDirectTransferPath` — pure walk/dolmus when no bus path exists.

---

## 7. Live bus positions

[ml/live.js](ml/live.js). For every trip that should be active right now (matched on day-of-week + time window in `hackathon_trips`):

```
currentPosition = interpolate(polyline, (now − departure + priorDelay) / plannedDuration)
```

The `priorDelay(lineId, hour, dow)` call is the same historical tensor from §4. It's schedule-driven, not GPS — and we label it clearly as such in the UI. Frontend polls every 4 s and `requestAnimationFrame`-tweens markers to avoid jitter against Leaflet's own pan transform.

---

## 8. Advisor — the rule layer on top of the ML

[ml/advisor.js](ml/advisor.js). Turns model outputs into a **single action per bus**. Not ML — it's deliberately rule-based because the decision surface is small, the stakes are real, and explainability matters more here than a marginal AUC bump.

```
stress(0-100) = 0.4 · occupancy
              + 0.25 · clamp(delay / 10)
              + 0.15 · rushHour
              + 0.1  · remainingStops / totalStops
              + 0.1  · inverse(speedFactor)

recommendation chip:
  if waitMin ≤ 2 and hasBus          → Run
  if afterLastTrip                   → Last bus warning
  if nextBusIn ≤ 12 min and ≥ 20pp cleaner → Wait for next
  if crowded now but high alighting  → Board, seats soon
  if long ride + crowded + terminal nearby → Walk back one stop
  if stress < 50                     → Board (Rahat)
  else                               → Board, crowded but no alternative
```

The chip is the **1-second answer**; the stress score, seat count, and turnover hint are secondary information for riders who want the reasoning.

---

## 9. End-to-end request flow

```
GET /api/stops/:stopId/advice
│
├── 1. Load schedule for (stop, all lines at this stop) — batched in ≤ 3 SQL round-trips
│       (hackathon_trips gives 350+ trips/line/day, hackathon_arrivals enriches with actuals)
│
├── 2. For each upcoming arrival in the next 2h:
│       ├── Arrival RF.predict(features) → delayMin, stddev
│       ├── Crowd = real avg_occupancy_pct  (fallback → RF.classify(features))
│       ├── Next scheduled bus on same line → alternative candidate
│       └── Advisor(delay, crowd, nextBus, stops remaining, speed factor) → chip + stress
│
├── 3. Attach factors ("rush hour +2 min", "rain +3 min") and etaBandMin (round(stddev × 1.28))
│
└── 4. Return { arrivals: [...], crowd, weather, modelInfo }
```

Typical response time: **20–80 ms** (gzip + composite DB indexes + single-pass forest traversal + batched schedule query).

---

## 10. What is *not* ML here (and why)

We were deliberate about where to spend modelling budget:

- **Delay cascade** — statistical baselines win on small per-cell sample sizes.
- **Advisor / recommendation** — rules are explainable, auditable, and tunable in seconds.
- **Journey planner** — Dijkstra on a well-defined graph with real distances.
- **Weather** — seeded from trip averages at startup; no forecast model needed for a hackathon dataset.

Adding models for these would have been sophistication theater. We have two ML models that do something real (minutes of delay, crowding class) and everything else is crisp, deterministic, explainable logic layered on top.

---

## 11. Reproducing metrics

```bash
docker compose up -d --build
# wait ~90s for data load + training, then:
curl http://localhost:3050/api/model/info | jq .
```

Every number in this document was pulled from that endpoint.

---

## 12. Known limitations & honest trade-offs

- **Chronological split vs. stratified split.** We stratify 80/20 across arrival observations; we did not cross-validate across distinct days. On a 14-day dataset this is acceptable but not ideal — a time-forward split might drop MAE by ~0.2 min or reveal drift.
- **`empty` recall at 50 %.** Border between `empty` and `light` at 15 % occupancy is fuzzy. Easy fix if needed: collapse to 4 classes (`light+empty / moderate / busy / crowded`) — or just live with it because the borderline is a behavioural distinction a rider doesn't care about.
- **No real GPS for live bus positions.** They are schedule + ML delay — clearly labelled in the UI. A future enhancement would consume an AVL stream; the interpolation math is already in place.
- **OSRM public demo reliability.** Free tier, 1.5 s timeout, haversine fallback. For production we would pin a self-hosted OSRM instance.
- **Future-time queries rely on priors.** For a weekday 3 weeks out we only have `(line, hour, dayOfWeek)` aggregates; we can't predict a one-off incident. We tier the confidence accordingly.

---

## 13. Ideas to improve the AI (next iterations)

Listed roughly in order of expected ROI:

1. **Gradient Boosted Trees (LightGBM / XGBoost via ONNX).** Random Forest is a robust baseline but GBMs typically shave 10–20 % off MAE on tabular regression with the same features. Shipping this as an optional Python microservice would be a 2-day upgrade.
2. **Temporal cross-validation.** Replace stratified split with a 12-train-day / 2-test-day walk-forward. The MAE that survives that is the MAE to quote publicly.
3. **Neighbour-stop features.** Current `recentDelay` is for the *same* stop. Adding *the same trip's delay at the previous stop* would make the regressor near-perfect on the last few stops of a route — the information is already in the DB.
4. **Conformal prediction bands.** Replace `stddev × 1.28` with split-conformal calibration on residuals for a true guaranteed 80 % / 95 % coverage instead of a normality assumption.
5. **Crowd model → ordinal regression.** Five classes have a natural order — modelling them as ordinal (cumulative link) instead of nominal avoids the `empty↔light` adjacency misclassification that dominates our error.
6. **Better delay cascade.** A small GRU over `(stop_sequence, hour_of_day)` sequences would catch non-linear snowball patterns the current additive model misses. Worth it only after more data — current 4.4 k arrivals is borderline for sequence models.
7. **Per-route models.** Five lines, fairly different behaviours. Training one forest per line (small trees, 30 estimators each) could capture route-specific dynamics better than a single global model, at the cost of deployment complexity.
8. **Passenger-flow prediction.** We ignore `hackathon_passengerFlow` aside from turnover averages. A small classifier predicting "will N people alight at stop X" would directly improve the `seat turnover` recommendation chip.
9. **Feedback loop / online learning.** Every served prediction could be logged, then compared to the realized delay once the bus arrives, feeding a slow retrain every hour. This is the single biggest durable accuracy gain — but requires ~1 week of production traffic to matter.
10. **Explainability panel.** SHAP values per prediction, rendered as a mini-bar in the advice card ("of this 4-min delay: +2 min rush, +1 min rain, +1 min segment drift"). More trust than raw numbers give.

If we had another two days, in this order: **#3 → #1 → #4**. They compound: better features feed a better model whose honest bands replace the Gaussian approximation.
