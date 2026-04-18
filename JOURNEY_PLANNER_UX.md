# Journey Planner — Use Case & Scenario Document

## Core Insight

Every transit app answers: "When does the bus arrive at my stop?"
We answer: **"When do I arrive at my destination?"**

The first bus to arrive is NOT always the fastest way to get there.
A bus that comes 5 minutes later but takes a faster route with fewer
intermediate stops may get you there sooner. This is the insight that
makes the Journey Planner a genuine differentiator.

---

## User Flow

### Current flow (without Journey Planner)
1. User opens app, sees map with stops
2. Clicks a stop or searches
3. Panel shows per-bus arrival cards (minutes until bus comes)
4. User picks the bus that arrives soonest
5. **Problem:** User has NO idea when they'll actually reach their destination

### New flow (with Journey Planner)
1. User opens app, sees map with stops
2. Clicks their origin stop (or searches)
3. Panel shows arrivals as before, PLUS a **destination input** at the top:
   `"Nereye gidiyorsun?"` (Where are you going?)
4. User types or selects a destination stop
5. **Panel transforms:** Each bus card now shows TOTAL journey time:
   - Wait time at this stop
   - Travel time to destination
   - Total = wait + travel
   - Comfort prediction along the journey
6. Best option star picks the fastest TOTAL journey, not just the first bus

---

## Scenarios

### Scenario 1: Student Going to University
**User:** Ayse, university student in Sivas
**Origin:** STP-L01-04 (her neighborhood stop)
**Destination:** STP-L03-08 (university stop)

**Without Journey Planner:**
- Sees: L01 arrives in 3 min, L03 arrives in 8 min
- Picks L01 because it comes first
- L01 takes 25 min to university (slow route, many stops, crowded)
- Total: 28 min, standing the whole way

**With Journey Planner:**
- Sees: L01 total 28 min (3 wait + 25 travel, crowded)
- Sees: L03 total 23 min (8 wait + 15 travel, seats available)
- Picks L03 — arrives 5 min earlier AND gets a seat
- The "best option" star is on L03

### Scenario 2: Commuter During Rush Hour
**User:** Mehmet, office worker
**Origin:** STP-L02-03 (central stop, busy)
**Destination:** STP-L05-10 (suburb)

**Panel shows:**
| Route | Wait | Travel | Total | Comfort |
|-------|------|--------|-------|---------|
| L02   | 2 dk | 32 dk  | 34 dk | Crowded → Crowded |
| L05   | 6 dk | 18 dk  | 24 dk | Moderate → Empty  |

L05 wins on total time AND comfort despite arriving later at the stop.

### Scenario 3: Night Service — No Journey Available
**User:** Selects destination at 00:30
**Result:** Journey cards show service-ended state with first bus times,
plus estimated journey time for the first morning bus:
"Ilk sefer 05:45 — tahmini variz 06:08 (23 dk yolculuk)"

### Scenario 4: No Direct Route
**User:** Selects two stops not connected by any single line
**Result:** "Bu iki durak arasinda direkt hat yok."
(No direct route between these stops.)
Future: transfer suggestions.

---

## UI Layout

### Panel Header (modified)
```
+------------------------------------------+
| [pin] Cumhuriyet Caddesi                 |
| Sivas · L01, L03, L05                   |
|                                          |
| Nereye gidiyorsun?                       |
| [____________________________] [X]       |
|   > Universite Kampusu                   |
|   > Hastane Duragi                       |
|   > Otogar                               |
+------------------------------------------+
```

### Journey Card (replaces arrival card when destination selected)
```
+------------------------------------------+
| [star] En Iyi Secenek                    |
|                                          |
| [L03]  -> Universite          23 dk      |
|           Kampusu             TOPLAM     |
|                                          |
|  8 dk bekle  +  15 dk yolculuk          |
|  [||||||||...] %35 dolu                  |
|                                          |
|  Duraklar: 4 → 8 (4 durak)             |
|  Konfor: Baslangic moderate → Varis empty|
|                                          |
|  [chip] Bin — rahat yolculuk            |
+------------------------------------------+
```

### Key UI Elements
- **Total time as the hero number** (big, colored, top-right)
- **Wait + Travel breakdown** below the hero
- **Comfort trajectory** showing how occupancy changes from origin to destination
- **Stop count** so user knows how many stops
- **Recommendation chip** considers total journey, not just arrival

---

## Data Requirements

From `hackathon_arrivals`, per trip between two stops on the same line:
- `scheduled_arrival` at origin and destination → scheduled travel time
- `cumulative_delay_min` difference → added delay during travel
- `dwell_time_min` at intermediate stops → time spent stopped
- `speed_factor` → current speed vs. scheduled speed

Query pattern:
```sql
-- Average travel time from stop A to stop B on a given line
SELECT
  AVG(TIMESTAMPDIFF(SECOND, a1.scheduled_arrival, a2.scheduled_arrival)) / 60 as avg_scheduled_min,
  AVG(a2.cumulative_delay_min - a1.cumulative_delay_min) as avg_added_delay,
  AVG(a2.avg_occupancy_pct) as avg_dest_occupancy
FROM hackathon_arrivals a1
JOIN hackathon_arrivals a2 ON a1.trip_id = a2.trip_id
WHERE a1.stop_id = ? AND a2.stop_id = ?
AND a1.line_id = ? AND a2.line_id = ?
AND a1.stop_sequence < a2.stop_sequence
```

## API Design

```
GET /api/journey?from=STP-L01-04&to=STP-L03-08
```

Response:
```json
{
  "from": { "id": "STP-L01-04", "name": "Cumhuriyet Caddesi" },
  "to": { "id": "STP-L03-08", "name": "Universite Kampusu" },
  "journeys": [
    {
      "routeId": "L03",
      "routeName": "...",
      "routeColor": "#...",
      "waitMin": 8,
      "travelMin": 15,
      "totalMin": 23,
      "stops": 4,
      "originOccupancyPct": 45,
      "destOccupancyPct": 20,
      "comfortTrend": "improving",
      "recommendation": { "action": "board", "text": "...", "priority": "ok" },
      "factors": [...],
      "serviceEnded": false
    }
  ],
  "bestJourney": 0
}
```
