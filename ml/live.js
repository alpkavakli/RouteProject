// ─── Live Bus Position Engine ───────────────────────────────────────────
//
// The hackathon dataset is a flattened weekday schedule (TIME columns,
// no calendar date). We treat it as "the timetable for a typical
// weekday" and project it onto the current wall-clock moment:
//
//   1. For the current day-of-week and time-of-day, find every trip
//      whose planned_departure + planned_duration straddles "now".
//   2. For each active trip, interpolate its position along its route's
//      ordered stop list using elapsed-since-departure / duration as
//      a fraction. This is the "schedule" position.
//   3. Shift that position by the ML-predicted delay for this
//      (line, hour, DOW) cell. A bus predicted to be 4 min late
//      appears 4 min behind its schedule slot on the polyline.
//
// So live positions are *schedule + ML-predicted delay*. The RF model
// isn't re-invoked for each bus on each tick (too expensive); instead
// we reuse the historical-prior tensor that predictor.js already
// computes at startup — same delay curve the future-time planner uses.

const { priorDelay } = require('./predictor');

// Hackathon CSV uses Mon=0 .. Sun=6. JS Date.getDay() uses Sun=0 .. Sat=6.
function jsDayToHackathonDow(jsDay) {
  return (jsDay + 6) % 7;
}

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

// Bearing in degrees from point a to b (simple flat-earth approximation —
// bus-stop segments are short enough that great-circle math is overkill).
function headingDeg(a, b) {
  const dLng = b.lng - a.lng;
  const dLat = b.lat - a.lat;
  const rad = Math.atan2(dLng, dLat);
  return ((rad * 180 / Math.PI) + 360) % 360;
}

async function getActiveBuses(pool, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const dow = jsDayToHackathonDow(now.getDay());
  const hour = now.getHours();
  const nowMin = minutesOfDay(now);
  // Clamp LIMIT to a safe integer — inlined because mysql2 prepared
  // statements reject `LIMIT ?` parameters across versions.
  const maxBuses = Math.max(1, Math.min(500, Math.floor(Number(opts.limit) || 120)));

  // 1) Candidate trips: dedupe by (line_id, planned_departure) since the
  //    CSV covers multiple weeks and the same scheduled slot repeats.
  const [trips] = await pool.execute(
    `SELECT line_id,
            ANY_VALUE(line_name) AS line_name,
            TIME_TO_SEC(planned_departure)/60 AS dep_min,
            AVG(planned_duration_min) AS duration_min,
            AVG(departure_delay_min) AS avg_dep_delay
       FROM hackathon_trips
      WHERE day_of_week = ?
        AND TIME_TO_SEC(planned_departure)/60 <= ?
        AND TIME_TO_SEC(planned_departure)/60 + planned_duration_min >= ?
      GROUP BY line_id, planned_departure
      LIMIT ${maxBuses}`,
    [dow, nowMin, nowMin]
  );

  if (trips.length === 0) return [];

  // 2) Load the ordered stop sequence for every line that has an active
  //    trip. Single query, grouped in-memory afterwards.
  const lineIds = [...new Set(trips.map(t => t.line_id))];
  const placeholders = lineIds.map(() => '?').join(',');
  const [stopRows] = await pool.execute(
    `SELECT rs.route_id AS line_id,
            rs.stop_order,
            s.id   AS stop_id,
            s.name AS stop_name,
            s.lat,
            s.lng
       FROM route_stops rs
       JOIN stops s ON s.id = rs.stop_id
      WHERE rs.route_id IN (${placeholders})
      ORDER BY rs.route_id, rs.stop_order`,
    lineIds
  );
  const [routeRows] = await pool.execute(
    `SELECT id, color FROM routes WHERE id IN (${placeholders})`,
    lineIds
  );

  const lineStops = {};
  for (const r of stopRows) {
    if (!lineStops[r.line_id]) lineStops[r.line_id] = [];
    lineStops[r.line_id].push(r);
  }
  const lineColor = {};
  for (const r of routeRows) lineColor[r.id] = r.color;

  // 3) Compute each active bus's current lat/lng.
  const buses = [];
  for (const trip of trips) {
    const stops = lineStops[trip.line_id];
    if (!stops || stops.length < 2) continue;

    // Delay from ML priors (same tensor predictor.js uses). Falls back
    // to the trip's own historical departure-delay average if this
    // (line, hour, dow) cell is empty.
    const mlDelay = priorDelay(trip.line_id, hour, dow, Number(trip.avg_dep_delay) || 0);

    // Effective departure = scheduled + predicted delay.
    const effectiveDepMin = Number(trip.dep_min) + mlDelay;
    const duration = Number(trip.duration_min);
    if (duration <= 0) continue;

    const elapsed = nowMin - effectiveDepMin;
    const progress = Math.max(0, Math.min(1, elapsed / duration));

    // Interpolate across stop segments.
    const n = stops.length;
    const segF = progress * (n - 1);
    const i = Math.min(Math.floor(segF), n - 2);
    const t = segF - i;
    const a = stops[i];
    const b = stops[i + 1];
    const lat = a.lat + (b.lat - a.lat) * t;
    const lng = a.lng + (b.lng - a.lng) * t;

    buses.push({
      // Stable key so the client can animate the same marker across polls.
      tripKey: `${trip.line_id}-${Math.round(trip.dep_min)}`,
      lineId: trip.line_id,
      lineName: trip.line_name,
      color: lineColor[trip.line_id] || '#F0547A',
      lat, lng,
      heading: headingDeg(a, b),
      progress: Math.round(progress * 1000) / 10,  // percent, 1 decimal
      delayMin: Math.round(mlDelay * 10) / 10,
      nextStop: t < 0.5 ? a.stop_name : b.stop_name,
      nextStopId: t < 0.5 ? a.stop_id : b.stop_id,
    });
  }

  return buses;
}

module.exports = { getActiveBuses };
