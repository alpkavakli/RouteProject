# RouteProject — Handoff Brief

You're joining an in-progress hackathon submission. Read this end-to-end before touching anything.

## What this is
RouteProject is our entry to a 2-week ML/product hackathon (2026-04-13 → 2026-04-27).
Case: **Predictive Transit** — "When will my bus actually arrive, and should I take it?"
Dataset: Sivas municipal bus data provided by the hackathon team (62 stops, 5 lines, ~13k trips, ~4.5k stop-arrival observations, ~3.6k passenger-flow rows).

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

Run: `docker compose up -d --build app` → http://localhost:3000 → pick Sivas → click any stop.
First startup trains both models from real data (~2 min total).

## What's already built
1. **DB schema**: cities, stops, routes, route_stops, weather + hackathon_trips, hackathon_arrivals, hackathon_passenger_flow. Init is idempotent; Sivas backfill is safe to rerun.
2. **CSV loader** (`db/load-csv.js`): parses 5 hackathon CSVs on first run, seeds a stable Sivas weather row from trip averages.
3. **ML predictor** (`ml/predictor.js`):
   - Arrival model: Random Forest Regressor, ~2.0 min MAE on real data.
   - Crowd model: Random Forest Classifier, 5-class (empty/light/moderate/busy/crowded). Empty class has ~0 samples — known quirk.
   - `predictArrivals(stop, routes, pool)` is async and pulls real `scheduledMin`, `recentDelay`, `segmentIndex`, `vehicleId`, `avgOccupancyPct`, `speedFactor`, and per-trip weather from hackathon_trips/hackathon_arrivals. Output is deterministic within the current minute — critical, it used to reroll on every click and we fixed it. Don't reintroduce `Math.random()` in the prediction path.
4. **Smart advisor** (`ml/advisor.js`): generates stress score (0–100, labels Rahat/Normal/Yoğun/Stresli), seat turnover hint from boarding/alighting, Turkish recommendation chip (run/wait/board/alternative/last-bus). Endpoint: `GET /api/stops/:id/advice`.
5. **Frontend** (`public/js/app.js`, `ui.js`, `data.js`; `public/css/components.css`): advice cards with hero countdown, occupancy bars, stress badge, recommendation chip, global advice banner. 5-class crowd card with probability bars. Auto-refresh every 30s.

## How the rendered card maps to the user
Hero: big countdown + recommendation chip. That's the 1-second takeaway. Everything else (occupancy/seats/stress/factors/turnover note) is secondary rows — do not promote them to the top.

## Known state / quirks
- DB volume is persistent across rebuilds. To fully reset: `docker compose down -v`.
- Model cache is deleted on every startup (`server.js` start()) to force retraining — this wastes ~2 min but guarantees fresh models; fine for now.
- `.env` is gitignored; credentials match `docker-compose.yml` (root/root, db `predictive_transit`).
- Turkish strings in the UI are intentional — the dataset is Sivas and the target users are Turkish-speaking.
- Non-Sivas cities still use the synthetic path with random scheduledMin. Only Sivas is real-data-backed.

## Open work a fresh session might pick up
- README/documentation refresh covering the advisor + real-data pipeline (high-value for scoring, currently stale).
- Demo narrative / presentation outline for the 04-20 graded checkpoint.
- Optional: live weather from an external API instead of the seeded trip average.
- Optional: external route/GTFS data if we can find Sivas public data.

## Working-with-the-user notes
- Windows host, Git Bash shell. Use forward slashes in paths.
- User switches between Claude Code and Antigravity. Responses should assume cold context.
- User prefers terse output, direct answers, no preambles.
- Before making risky changes (destructive git, forced rebuilds that lose DB state), confirm first.
- When in doubt about scope: "simple and complete" beats "complex and half-working." This is an explicit hackathon strategy rule for this project.
