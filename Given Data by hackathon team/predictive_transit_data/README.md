# Predictive Transit — Synthetic Dataset
## Anadolu Hackathon 2026 | Case 2

### Overview
This dataset simulates urban bus transit operations in Sivas, Turkey (March 2025).
Designed to support real-time bus arrival prediction and stop crowd estimation models.
Inspired by Yandex Shifts data structure (vehicle motion prediction + weather).

- **Geographic scope**: Sivas city center, 39.60–39.80°N, 36.95–37.15°E
- **Time period**: March 1–30, 2025
- **Bus lines**: 5 lines (L01–L05), 62 stops total
- **Total trips**: ~13,400 | **Stop arrival observations**: ~4,500

---

### Files

#### 1. `bus_stops.csv` — Static stop metadata (62 rows)

| Column | Description |
|--------|-------------|
| stop_id | Unique stop ID (STP-LXX-NN) |
| line_id / line_name | Bus line identifier and name |
| stop_sequence | Position on route (1-indexed) |
| latitude / longitude | GPS coordinates |
| stop_type | terminal / transfer_hub / university / hospital / market / residential / regular |
| is_terminal | 1 if first or last stop on line |
| is_transfer_hub | 1 if passengers can transfer lines |
| distance_from_prev_km | Distance from previous stop (km) |
| scheduled_travel_time_min | Planned travel time from previous stop (min) |
| shelter_available | 1 if covered shelter at stop |
| bench_available | 1 if seating is available |

#### 2. `bus_trips.csv` — One row per scheduled bus run (13,440 rows)

| Column | Description |
|--------|-------------|
| trip_id | Unique trip ID (TRP-XXXXX) |
| line_id / line_name | Bus line |
| date / day_of_week / is_weekend | Temporal metadata |
| planned_departure | Scheduled first stop departure |
| actual_departure | Real departure time |
| departure_delay_min | Delay at route start (min) |
| planned_duration_min | Total scheduled trip time |
| actual_duration_min | Real trip duration |
| total_delay_min | End-to-end delay (actual - planned) |
| num_stops | Stops on this line |
| weather_condition | clear / cloudy / rain / snow / fog / wind |
| temperature_c | Air temperature (°C) |
| precipitation_mm | Precipitation during trip (mm) |
| wind_speed_kmh | Wind speed (km/h) |
| humidity_pct | Relative humidity (%) |
| traffic_level | low / moderate / high / congested |
| speed_factor | Composite travel speed multiplier [0–1]; lower = slower |
| bus_capacity | Total seats (60) |
| avg_occupancy_pct | Average load during trip |

#### 3. `stop_arrivals.csv` — Per-stop bus arrival records (~4,500 rows)
**This is the primary prediction target table.**

| Column | Description |
|--------|-------------|
| observation_id | Unique record ID |
| trip_id / line_id / stop_id | Foreign keys |
| stop_sequence / stop_type | Stop position and category |
| date / day_of_week / hour_of_day / time_bucket | Temporal features |
| planned_arrival | Scheduled arrival datetime |
| actual_arrival | Real arrival datetime |
| delay_min | Arrival delay in minutes (negative = early) |
| is_delayed | 1 if delay_min > 2 minutes |
| passengers_waiting | People at stop when bus arrives **[TARGET for crowd model]** |
| passengers_boarding | Passengers who board |
| passengers_alighting | Passengers who exit |
| dwell_time_min | Time bus spends at stop |
| cumulative_delay_min | Delay accumulated since trip start |
| weather_condition / traffic_level / speed_factor | Conditions at observation time |
| minutes_to_next_bus | Estimated gap to next bus on same line |

#### 4. `passenger_flow.csv` — Aggregated crowd statistics (~3,500 rows)
Pre-aggregated by stop × hour × day-of-week × weather. Useful for baseline features.

| Column | Description |
|--------|-------------|
| stop_id / line_id / stop_type | Stop identifiers |
| hour_of_day / day_of_week / is_weekend / time_bucket | Time grouping |
| weather_condition | Weather category |
| avg_passengers_waiting | Mean crowd at stop |
| avg_passengers_boarding | Mean boardings per arrival |
| avg_dwell_time_min | Mean dwell time |
| sample_count | Observations in this group |
| std_passengers_waiting | Crowd standard deviation |
| max_passengers_waiting | Peak crowd observed |
| crowding_level | empty / light / moderate / busy / crowded |

#### 5. `weather_observations.csv` — Weather readings (300 records)

| Column | Description |
|--------|-------------|
| obs_id / timestamp / latitude / longitude | When and where |
| weather_condition | Category |
| temperature_c / feels_like_c | Temperature (°C) |
| precipitation_mm / precipitation_type | Rain or snow amount |
| wind_speed_kmh / wind_direction_deg | Wind |
| humidity_pct / pressure_hpa / visibility_km | Atmospheric conditions |
| road_surface | dry / wet / icy / snow_covered |
| transit_delay_risk | Composite weather-based delay risk [0–1] |
| passenger_demand_multiplier | Weather-driven crowd boost factor |

---

### Key Dataset Statistics
| Metric | Value |
|--------|-------|
| Average arrival delay | 8.2 min |
| % of stops with delay > 2 min | 66.3% |
| Average passengers waiting | 34.2 |
| Max passengers at a stop | 180 |
| Bus lines | 5 |
| Total trips | 13,440 |

---

### Suggested ML Tasks
1. **Arrival time prediction** — predict `delay_min` using weather + traffic + cumulative_delay + time features. **Metric: MAE**
2. **Crowd estimation** — predict `passengers_waiting` at a stop. **Metric: RMSE**
3. **Crowding classification** — predict `crowding_level` (multi-class: empty → crowded)
4. **Real-time ETA** — end-to-end `minutes_to_next_bus` for the live map UI

### Evaluation Metrics (per case spec)
- **MAE** for arrival time prediction
- **RMSE** for number of passengers waiting
- Interface must display forecast readable within 1 second (UX criterion)
