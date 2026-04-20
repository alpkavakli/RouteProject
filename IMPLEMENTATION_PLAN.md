# Implementation Plan

Working scratchpad for the current in-flight / queued features. Ordered by priority.

---

## 1. Bus #3 in Walk Advisor  *(in progress — small fix)*

Current leave-by advisor only surfaces bus #1 + (synthesized) bus #2 from `minutesToNextBus`. If user's walk time exceeds bus #2's arrival, the card falls through to "Missed · Too late" even though bus #3 is already in the predictor's candidate window.

**Changes:**
- `ml/predictor.js` — emit `futureBusMins: number[]` alongside `minutesToNextBus`. Array is minutes-from-now for each entry in the existing `candidates.slice(0, 3)` window, with midnight wrap handled the same way as bus #1.
- `ml/advisor.js` — pass-through (one new field in the options map).
- `public/js/ui.js` — rewrite `_pickLeaveOptions` to iterate `opt.futureBusMins`. Keep the legacy `predictedMin + minutesToNextBus` synthesis as a fallback branch for defensiveness.

No API shape breaks. No new endpoint. Frontend-only UX tweak after the field is added.

---

## 2. "Schedule a ride" — Arrival-time planner  *(queued — next)*

Replaces the walk-minutes picker with a datetime input. User says "I want to be at the stop at `Mon 09:15`" and the card returns the buses whose ML-predicted arrival is closest to that time, ranked. Tiny walk-offset slider stays inside the card so leave-by math still works.

### Goal (user-facing)

Primary question the card answers: **"Which bus should I target if I need to be at the stop at time T?"**

Secondary (walk offset): **"…and when should I leave home given the walk time?"**

### Why the ML model handles this

`ml/arrival-model.js` is trained on features that generalize across time: `hour`, `dayOfWeek`, `isRushHour`, `temperature`, `precipitation`, `windSpeed`, `scheduledMinutes`, `stopPopularity`, `routeAvgDelay`, `recentDelay`, `segmentIndex`. The features `hour` / `dayOfWeek` / `isRushHour` carry the "weekday vs weekend" and "peak-hour delays frequent" signal the model needs to predict future times. `recentDelay` and live weather don't generalize — for future predictions we'll substitute route- and hour-conditioned averages.

Accuracy falls off the further out the target is:
- Later today: strong (live `recentDelay` still relevant)
- Tomorrow / this week: moderate (relies on hour/day priors)
- Beyond that: weak — we'll surface a "schedule-only estimate" badge instead of the ML badge.

### API: new endpoint

```
GET /api/stops/:id/at?time=<ISO8601>&window=<minutes>
```

- `time` — target arrival datetime (defaults to now + 15 min if omitted).
- `window` — ± search window around target (default 30 min, max 90).

Returns trips from `hackathon_trips` whose scheduled arrival at this stop falls inside `[time - window, time + window]`, with the arrival model applied to each:

```json
{
  "stopId": "STP-L01-05",
  "stopName": "Hospital 05",
  "targetTime": "2026-04-21T09:15:00Z",
  "window": 30,
  "options": [
    {
      "routeId": "L01",
      "routeColor": "#ef4444",
      "destination": "…",
      "scheduledAt": "2026-04-21T09:08:00Z",
      "predictedAt": "2026-04-21T09:14:00Z",
      "predictedDelayMin": 6,
      "diffFromTargetMin": -1,
      "crowdLevel": "moderate",
      "occupancyPct": 55,
      "confidence": 0.62,
      "accuracyTier": "same-day" | "same-week" | "far-future"
    },
    …
  ],
  "bestMatch": 0
}
```

### Predictor changes (`ml/predictor.js`)

New function `predictAtTime(stopId, targetDate, windowMin)`:

1. Query `hackathon_trips` joined with `hackathon_arrivals` for trips on the same `day_of_week` as target, whose scheduled arrival at `stopId` falls in the window.
2. For each trip, build the feature vector:
   - `hour` = target hour
   - `dayOfWeek` = target DOW
   - `isRushHour` = derived
   - `scheduledMinutes` = scheduled-arrival-at-stop offset from trip start
   - `stopPopularity`, `routeAvgDelay`, `segmentIndex` = same as live path
   - **Weather**: for same-day, use live/seeded weather; for future days, use route-hour-DOW historical averages pre-computed once at startup and cached.
   - **`recentDelay`**: for same-day use live; for future days, fall back to `routeAvgDelay * hourFactor` where hourFactor is the hour-of-day multiplier derived from historical delay-by-hour aggregates.
3. Run the arrival model to get `predictedDelayMin`.
4. Build `predictedAt = scheduledAt + predictedDelayMin`.
5. Attach `accuracyTier`:
   - `same-day` if target is today → ML-powered.
   - `same-week` if ≤7 days → ML-powered with lower confidence.
   - `far-future` → schedule + route-hour-DOW average delay only (no live features).

### Frontend (`public/index.html`, `public/js/ui.js`, `public/js/app.js`, `public/js/data.js`)

- Replace the walk-minutes pills with a datetime picker (`<input type="datetime-local">`) + a small walk-offset input kept as a secondary control. Default target = now + 15 min.
- New card title: **"Plan a ride"** (primary mode) with a mode toggle back to **"Leave now"** (existing live-arrivals behavior).
- `DataService.getStopAtTime(stopId, iso, windowMin)` — new client method.
- Render each option as a card: big scheduled time · predicted time · diff-from-target · crowd chip · accuracy tier badge.
- "Leave by X:XX" chip under the best match uses `predictedAt - walkOffsetMin`.

### Phased build order

1. **Backend foundation** — precompute historical delay-by-hour-DOW map at startup; add `predictAtTime()`; wire `/api/stops/:id/at` endpoint. Sanity-check output against live `/advice` for `time=now`.
2. **Frontend scaffolding** — swap the leave card inputs to datetime picker; keep walk-offset slider; call new endpoint.
3. **UX polish** — accuracy-tier badge, "best match" highlight, empty state for windows with no buses, collapse mode back to leave-now.

### Out of scope for this pass

- Arrive-by-destination planning (that's Feature #1 Journey Planner's territory).
- Recurring commute scheduling / saved trips.
- Push notifications / reminders.

---

## 3. Historical Pattern Insights  *(backlog)*

Aggregate cards like "L03 always late on rainy days", "Tuesday 17:00 is worst rush hour, not Monday", "Stop X empties after stop 10." Pure SQL aggregates over `hackathon_arrivals` + `hackathon_trips` + weather — cheap to build, high demo value. Queued behind the scheduler because it needs the same historical delay-by-hour-DOW table we're about to compute.

---

## 4. Boarding Strategy / Comfort Optimization  *(backlog)*

Predict seat availability at each stop using boarding/alighting patterns. Recommend which line gives the fastest *seated* journey (not just fastest arrival). Extends the advisor with a comfort dimension. Low priority — the current crowd + stress model already covers ~80% of this.
