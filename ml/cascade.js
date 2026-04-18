// ─── Delay Cascade Model ────────────────────────────────────────────────
//
// Models how delay snowballs along a bus route. Uses historical
// `cumulative_delay_min` per (route, stop_sequence) to learn the typical
// delay accumulation curve. Given a current delay at one stop, projects
// how much delay riders should expect at every downstream stop.
//
// The visualization on the frontend turns the route polyline into a
// green→red gradient — the further you ride, the worse it gets.

let pool = null;

// baseline[routeId] = [{ stopSequence, stopId, avgCumDelay, samples }]
const baseline = new Map();

// stopMeta[routeId] = { id, name, lat, lng, stopSequence }[] (ordered)
const routeStops = new Map();

async function init(dbPool) {
  pool = dbPool;
  await loadBaseline();
  await loadRouteStops();
  console.log(`[cascade] Initialized — ${baseline.size} routes, ${routeStops.size} route stop chains`);
}

async function loadBaseline() {
  const [rows] = await pool.query(`
    SELECT line_id, stop_sequence,
           AVG(cumulative_delay_min) AS avg_cum,
           COUNT(*) AS samples
    FROM hackathon_arrivals
    WHERE cumulative_delay_min IS NOT NULL
    GROUP BY line_id, stop_sequence
    ORDER BY line_id, stop_sequence
  `);

  baseline.clear();
  rows.forEach(r => {
    if (!baseline.has(r.line_id)) baseline.set(r.line_id, []);
    baseline.get(r.line_id).push({
      stopSequence: r.stop_sequence,
      avgCumDelay: Number(r.avg_cum) || 0,
      samples: r.samples,
    });
  });
}

async function loadRouteStops() {
  const [rows] = await pool.query(`
    SELECT rs.route_id, rs.stop_id, rs.stop_order, s.name, s.lat, s.lng
    FROM route_stops rs
    JOIN stops s ON rs.stop_id = s.id
    ORDER BY rs.route_id, rs.stop_order
  `);

  routeStops.clear();
  rows.forEach(r => {
    if (!routeStops.has(r.route_id)) routeStops.set(r.route_id, []);
    routeStops.get(r.route_id).push({
      id: r.stop_id,
      name: r.name,
      lat: Number(r.lat),
      lng: Number(r.lng),
      // route_stops.stop_order is 0-indexed; normalize to 1-indexed so it
      // aligns with hackathon_arrivals.stop_sequence used by the baseline.
      stopSequence: r.stop_order + 1,
    });
  });
}

// Map a delay value to a severity bucket + color (green→red gradient).
function severity(delayMin) {
  if (delayMin < 3)  return { level: 'low',      color: '#22c55e', label: 'Az' };
  if (delayMin < 7)  return { level: 'moderate', color: '#84cc16', label: 'Hafif' };
  if (delayMin < 12) return { level: 'high',     color: '#f59e0b', label: 'Orta' };
  if (delayMin < 20) return { level: 'severe',   color: '#f97316', label: 'Yüksek' };
  return                     { level: 'critical', color: '#ef4444', label: 'Kritik' };
}

// Predict the delay cascade for a route starting from a given stop.
//
// fromStopId: stop user has selected (cascade starts here)
// currentDelay: optional override — if provided, we keep the EXCESS over
//   the baseline at this stop and add it to every downstream baseline.
//   That way a "running late" bus is projected as still running late.
function predictCascade(routeId, fromStopId, currentDelay = null) {
  const stops = routeStops.get(routeId);
  const base = baseline.get(routeId);
  if (!stops || !base) return null;

  const fromIdx = stops.findIndex(s => String(s.id) === String(fromStopId));
  if (fromIdx === -1) return null;

  // Build a map sequence → baseline cumulative delay
  const baseBySeq = new Map(base.map(b => [b.stopSequence, b.avgCumDelay]));

  const fromStop = stops[fromIdx];
  const fromBaseline = baseBySeq.get(fromStop.stopSequence) ?? 0;

  // Excess delay this trip is carrying vs typical
  const excess = currentDelay != null
    ? currentDelay - fromBaseline
    : 0;

  // Project for the selected stop and every downstream stop
  const projection = stops.slice(fromIdx).map(stop => {
    const baselineDelay = baseBySeq.get(stop.stopSequence) ?? 0;
    const predictedDelay = Math.max(0, baselineDelay + excess);
    const sev = severity(predictedDelay);
    return {
      stopId: stop.id,
      stopName: stop.name,
      stopSequence: stop.stopSequence,
      lat: stop.lat,
      lng: stop.lng,
      predictedDelay: Number(predictedDelay.toFixed(1)),
      baselineDelay: Number(baselineDelay.toFixed(1)),
      severity: sev.level,
      color: sev.color,
      severityLabel: sev.label,
    };
  });

  if (projection.length === 0) return null;

  const start = projection[0];
  const end = projection[projection.length - 1];
  const delayGrowth = Number((end.predictedDelay - start.predictedDelay).toFixed(1));

  // Find the first stop where delay enters each severity tier — useful for
  // the "delay hits XX min by stop Y" headline.
  const firstSevereStop = projection.find(p => p.severity === 'severe' || p.severity === 'critical');

  return {
    routeId,
    fromStopId: fromStop.id,
    fromStopName: fromStop.name,
    terminalStopName: end.stopName,
    startDelay: start.predictedDelay,
    endDelay: end.predictedDelay,
    delayGrowth,
    downstreamStopCount: projection.length - 1,
    firstSevereStop: firstSevereStop ? {
      name: firstSevereStop.stopName,
      delay: firstSevereStop.predictedDelay,
      sequence: firstSevereStop.stopSequence,
    } : null,
    stops: projection,
    currentDelayOverride: currentDelay,
    samples: base.find(b => b.stopSequence === fromStop.stopSequence)?.samples ?? 0,
  };
}

function isInitialized() {
  return baseline.size > 0;
}

module.exports = {
  init,
  predictCascade,
  isInitialized,
  _internal: { severity },
};
