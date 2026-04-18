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

Run: `docker compose up -d --build` → http://localhost:3000 → pick Sivas → click any stop.
First startup trains both models from real data (~125s total).
If port 3306 conflict: `docker stop vak-vgs-db-1` (user's other project holds 3306).

---

## CURRENT STATE (2026-04-16, evening update)

### What's DONE and working:
1. **ML models** — RF Regressor (arrival delay, MAE 2.02min), RF Classifier (5-class crowd, 100% acc)
2. **Smart Advisor** (`ml/advisor.js`) — stress scoring, seat turnover, 7-priority recommendation chips
3. **Night service detection** — SERVICE_GAP_MIN=180, serviceEnded flag, moon badge, bestOption=-1
4. **Test suite** — 53 tests: unit (predictor + advisor helpers with BVA/EP) + live integration
5. **UX polish** — model info polls until trained, service-ended badge, run-badge suppression
6. **Bus time bug fix** — `loadAllSchedules()` now uses `hackathon_trips` (352/day/line) as primary source, not sparse `hackathon_arrivals` (7/day/stop)
7. **Journey Planner — FULL STACK COMPLETE:**
   - Backend: `GET /api/journey?from=X&to=Y` — direct + transfer journeys
   - Transfer support: walks <1km, dolmus/taxi for longer distances
   - Frontend: destination search, journey cards (direct + transfer layouts), map highlighting
   - Auto-refresh works in both arrivals and journey mode
   - All 5 Sivas lines × any combination works (same-line direct, cross-line transfer)

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

## What's NEXT After Journey Planner Frontend

### Feature #2: Delay Cascade Visualization
- Model delay propagation using `cumulative_delay_min` from hackathon_arrivals
- Route line on map: green→red gradient showing predicted delay at each stop
- New endpoint: `GET /api/routes/:id/delay-cascade`
- See `memory/project_differentiation_ideas.md` for details on all 5 features

### Documentation
- Update README with Journey Planner
- Update DOCUMENTATION.md
- Demo narrative for 04-20 checkpoint

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
