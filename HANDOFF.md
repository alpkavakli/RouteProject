# RouteProject — Handoff Brief

You're joining an in-progress hackathon submission. Read this end-to-end before touching anything.

## What this is
RouteProject is our entry to a 2-week ML/product hackathon (2026-04-13 → 2026-04-27).
Case: **Predictive Transit** — "When will my bus actually arrive, and should I take it?"
Dataset: Sivas municipal bus data provided by the hackathon team (118 stops, 5 lines, ~4.5k stop-arrival observations, ~3.6k passenger-flow rows).

Deadlines:
- 2026-04-16 — Checkpoint 1, idea only (feedback, not graded)
- **2026-04-20 — Checkpoint 2 GRADED, leaderboard decided**
- 2026-04-22 — Final pitch (top 9)
- 2026-04-27 — Hackathon ends

Scoring (0–2 each, compound): code quality, task relevance, UX/UI, ML usage, presentation.
Most teams lose points on UX clarity and real ML usage. "Accuracy > fancy AI." External datasets are allowed. Documentation weighs heavily.
**UX rule: user must understand the main signal in 1 second.**

## Stack
- Node.js + Express backend (`server.js`)
- MySQL 8 via mysql2 (`db/connection.js`, `db/init.js`)
- ML: `ml-random-forest` npm package (Random Forest Regressor for arrivals, Classifier for crowd)
- Frontend: vanilla JS modules (no framework) + Leaflet map
- Docker compose (`docker-compose.yml`) for app + db
- Tests: `node:test` built-in runner, 53 tests (`npm test`)

Run: `docker compose up -d --build` → http://localhost:3050 → pick Sivas → click any stop.
First startup trains both models from real data (~125s total).
If port 3306 conflict: `docker stop vak-vgs-db-1` (user's other project holds 3306).

---

## CURRENT STATE (2026-04-20, graded checkpoint day)

### What's DONE and working:
1. **ML models** — RF Regressor (arrival delay, MAE ~1.85min), RF Classifier (5-class crowd, 100% acc)
2. **Smart Advisor** (`ml/advisor.js`) — stress scoring, seat turnover, 7-priority recommendation chips
3. **Night service detection** — SERVICE_GAP_MIN=180, serviceEnded flag, moon badge, bestOption=-1
4. **Test suite** — 53 tests: unit (predictor + advisor helpers with BVA/EP) + live integration
5. **UX polish** — model info polls until trained, service-ended badge, run-badge suppression, dark mode w/ theme toggle
6. **Bus time bug fix** — `loadAllSchedules()` now uses `hackathon_trips` (352/day/line) as primary source, not sparse `hackathon_arrivals` (7/day/stop)
7. **Journey Planner — FULL STACK COMPLETE:**
   - Backend: `GET /api/journey?from=X&to=Y` — Dijkstra over bus edges + walking transfers, forced-transfer fallback for far-apart lines (dolmus leg)
   - **OSRM walk routing (2026-04-20):** public `router.project-osrm.org/foot` server, 1.5s timeout, 500-entry LRU cache, haversine fallback on failure. Walk legs carry `routed: true` + polyline `coords` for map rendering.
   - Frontend: destination search, leg-by-leg stepper (`Walk 180m (3 min) → L03 → …`), OSRM geometry drawn as dashed orange polyline
   - Auto-refresh works in both arrivals and journey mode
8. **Delay Cascade** — `/api/cascade?routeId=X&fromStopId=Y`, green→red map gradient + per-stop predicted delay summary card. Module: `ml/cascade.js`. Best demo: L01 (delay grows 1→15 min across 13 stops).
9. **Live Bus Positions** — `/api/live-buses`, active trips interpolated along stop sequence with ML-predicted delay applied. 4s polling, rAF-tweened markers with bus-icon divIcons. No GPS; schedule + ML.
10. **"When Should I Leave?" advisor** — frontend-only, walk-time pills (1/3/5/10 + custom), renders 3 leave-by options with crowd tags.
11. **ETA Confidence Bands (2026-04-20)** — std-dev across the 50 RF trees × 1.28 → `± X min · Y%` under every countdown. `etaBandMin` in `/advice` payload; styling in `public/css/advice.css`.

#### API response shape (`GET /api/journey?from=STP-L01-04&to=STP-L01-12`):
```json
{
  "from": { "id": "STP-L01-04", "name": "..." },
  "to": { "id": "STP-L01-12", "name": "..." },
  "journeys": [
    {
      "routeId": "L01",
      "routeName": "...",
      "routeColor": "#4f8cff",
      "destination": "...",
      "waitMin": 5,
      "travelMin": 18,
      "totalMin": 23,
      "stops": 8,
      "originOccupancyPct": 45,
      "destOccupancyPct": 20,
      "comfortTrend": "improving",
      "stressScore": 35,
      "stressLabel": "Normal",
      "recommendation": { "action": "board", "text": "...", "icon": "✅", "priority": "ok" },
      "serviceEnded": false,
      "mlPowered": true
    }
  ],
  "bestJourney": 0
}
```

---

## What's NEXT

### Backlog (from `memory/project_differentiation_ideas.md`)
- **Historical Pattern Insights** — "L03 always late on rainy days", "Tuesday 17:00 is worst rush hour, not Monday" — SQL aggregates + card UI.
- **Boarding Strategy / Comfort Optimization** — predict seat availability per stop, recommend fastest *seated* journey.
- **"Schedule a ride" planner** — datetime picker + `predictAtTime()` for arrive-by queries (see IMPLEMENTATION_PLAN.md §2).

### Documentation
- DOCUMENTATION.md is stale — still references pre-advice endpoints and doesn't cover journey/cascade/live/ETA-bands. Rewrite needed before final pitch.
- Demo narrative for 04-22 final pitch.

---

## Key Files

| File | Purpose |
|------|---------|
| `server.js` | Express routes, all API endpoints |
| `ml/predictor.js` | Arrival + crowd models, `predictArrivals()`, `predictCrowd()` |
| `ml/advisor.js` | Stress scoring, recommendations, `generateAdvice()` |
| `ml/journey.js` | Journey planner: direct + transfer routing, `planJourney()` |
| `ml/arrival-model.js` | RF Regressor (delay prediction) |
| `ml/crowd-model.js` | RF Classifier (5-class crowd) |
| `ml/data-generator.js` | Synthetic + real data loaders |
| `public/js/app.js` | App controller (init, city switch, stop selection, refresh) |
| `public/js/ui.js` | All rendering (weather, crowd, arrivals, advice, journey, model info) |
| `public/js/data.js` | DataService — fetch wrapper for all API calls |
| `public/js/map.js` | Leaflet map, stop markers, route lines, journey highlighting |
| `public/css/components.css` | Card styles, badges, chips |
| `public/css/advice.css` | Advice card specific styles |
| `test/*.test.js` | Test suite (`npm test`) |
| `JOURNEY_PLANNER_UX.md` | Full UX spec with scenarios |

## Working-with-the-user notes
- Windows host, Git Bash shell. Use forward slashes in paths.
- User prefers terse output, direct answers, no preambles.
- Before making risky changes (destructive git, forced rebuilds), confirm first.
- "Simple and complete" beats "complex and half-working." Ship a reliable demo.
- UX rule: every card needs a 1-second hero takeaway.
- Turkish UI strings are intentional — target users are Turkish.
- Only Sivas has real data. Other cities use synthetic fallback.
- Don't reintroduce `Math.random()` in the prediction path — outputs must be deterministic within the current minute.
