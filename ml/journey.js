// ─── Journey Planner Engine ─────────────────────────────────────────────
// Graph-based pathfinder: Dijkstra over a transit graph (bus edges + walk
// transfers) to find the optimal route between any two stops.
// Falls back to forced-transfer construction when no natural path exists.

const AVG_MIN_PER_SEGMENT = 4;      // avg minutes between consecutive stops
const NATURAL_TRANSFER_M  = 2000;   // stops within 2km = natural walking transfer
const WALK_SPEED_M_MIN    = 83.3;   // 5 km/h
const DOLMUS_SPEED_M_MIN  = 333;    // 20 km/h minibus
const TRANSFER_PENALTY    = 8;      // penalty minutes added to any transfer

// ─── Haversine ──────────────────────────────────────────────────────────

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Graph Builder ──────────────────────────────────────────────────────

function buildTransitGraph(allRoutes, allStops) {
  const graph = {};
  const stopMap = {};
  allStops.forEach(s => { stopMap[s.id] = s; graph[s.id] = []; });

  // 1) Bus edges — consecutive stops on the same route
  for (const route of allRoutes) {
    const stops = route.stops || [];
    for (let i = 0; i < stops.length - 1; i++) {
      if (!graph[stops[i]]) graph[stops[i]] = [];
      graph[stops[i]].push({
        to: stops[i + 1],
        weight: AVG_MIN_PER_SEGMENT,
        type: 'bus',
        routeId: route.id,
        routeColor: route.color,
        routeName: route.name,
      });
    }
  }

  // 2) Walking transfer edges — only between stops within NATURAL_TRANSFER_M
  for (let i = 0; i < allStops.length; i++) {
    for (let j = i + 1; j < allStops.length; j++) {
      const a = allStops[i], b = allStops[j];
      const aLine = (a.routes || [])[0];
      const bLine = (b.routes || [])[0];
      if (aLine && bLine && aLine === bLine) continue;

      const dist = haversineDistance(a.lat, a.lng, b.lat, b.lng);
      if (dist > NATURAL_TRANSFER_M) continue;

      const distM = Math.round(dist);
      const transferMin = Math.ceil(distM / WALK_SPEED_M_MIN);
      const edge = { weight: transferMin + TRANSFER_PENALTY, type: 'walk', distM, transferMin };

      graph[a.id].push({ ...edge, to: b.id });
      graph[b.id].push({ ...edge, to: a.id });
    }
  }

  return { graph, stopMap };
}

// ─── Dijkstra ───────────────────────────────────────────────────────────

function dijkstra(graph, startId, endId) {
  const dist = {};
  const prev = {};
  const prevEdge = {};
  const visited = new Set();

  for (const id of Object.keys(graph)) dist[id] = Infinity;
  dist[startId] = 0;

  const pq = [{ id: startId, d: 0 }];

  while (pq.length > 0) {
    pq.sort((a, b) => a.d - b.d);
    const { id: u } = pq.shift();
    if (visited.has(u)) continue;
    visited.add(u);
    if (u === endId) break;

    for (const edge of (graph[u] || [])) {
      const alt = dist[u] + edge.weight;
      if (alt < dist[edge.to]) {
        dist[edge.to] = alt;
        prev[edge.to] = u;
        prevEdge[edge.to] = edge;
        pq.push({ id: edge.to, d: alt });
      }
    }
  }

  if (dist[endId] === Infinity) return null;

  const steps = [];
  let cur = endId;
  while (cur !== startId) {
    steps.unshift({ stopId: cur, edge: prevEdge[cur] });
    cur = prev[cur];
  }
  steps.unshift({ stopId: startId, edge: null });
  return { steps, totalWeight: dist[endId] };
}

// ─── Forced-Transfer Fallback ───────────────────────────────────────────
// When Dijkstra finds no path (lines too far apart for walking transfers),
// build a 3-leg route: bus on origin line → dolmus → bus on dest line.

function buildForcedTransferPath(fromStop, toStop, allRoutes, allStops) {
  const stopMap = {};
  allStops.forEach(s => { stopMap[s.id] = s; });

  // Find the origin's route and destination's route
  for (const originRoute of allRoutes) {
    const fromIdx = (originRoute.stops || []).indexOf(fromStop.id);
    if (fromIdx === -1) continue;

    for (const destRoute of allRoutes) {
      if (originRoute.id === destRoute.id) continue;
      const toIdx = (destRoute.stops || []).indexOf(toStop.id);
      if (toIdx === -1) continue;

      // Find closest stop pair: exit stop on originRoute (after origin),
      // board stop on destRoute (before destination)
      let bestDist = Infinity, bestPair = null;

      for (let i = fromIdx + 1; i < originRoute.stops.length; i++) {
        const exitStop = stopMap[originRoute.stops[i]];
        if (!exitStop) continue;
        for (let j = 0; j < toIdx; j++) {
          const boardStop = stopMap[destRoute.stops[j]];
          if (!boardStop) continue;
          const d = haversineDistance(exitStop.lat, exitStop.lng, boardStop.lat, boardStop.lng);
          if (d < bestDist) {
            bestDist = d;
            bestPair = { exitIdx: i, boardIdx: j, distM: Math.round(d) };
          }
        }
      }

      if (!bestPair) continue;

      // Build 3-leg path: bus1 → transfer → bus2
      const steps = [];

      // Leg 1: bus on origin route from fromStop to exit stop
      steps.push({ stopId: fromStop.id, edge: null });
      for (let i = fromIdx + 1; i <= bestPair.exitIdx; i++) {
        steps.push({
          stopId: originRoute.stops[i],
          edge: {
            to: originRoute.stops[i],
            weight: AVG_MIN_PER_SEGMENT,
            type: 'bus',
            routeId: originRoute.id,
            routeColor: originRoute.color,
            routeName: originRoute.name,
          },
        });
      }

      // Transfer edge
      const distM = bestPair.distM;
      let transferMin, mode;
      if (distM <= 1000) {
        mode = 'walk';
        transferMin = Math.ceil(distM / WALK_SPEED_M_MIN);
      } else {
        mode = 'dolmus';
        transferMin = Math.ceil(distM / DOLMUS_SPEED_M_MIN) + 3;
      }

      steps.push({
        stopId: destRoute.stops[bestPair.boardIdx],
        edge: {
          to: destRoute.stops[bestPair.boardIdx],
          weight: transferMin + TRANSFER_PENALTY,
          type: mode,
          distM,
          transferMin,
        },
      });

      // Leg 2: bus on dest route from board stop to toStop
      for (let j = bestPair.boardIdx + 1; j <= toIdx; j++) {
        steps.push({
          stopId: destRoute.stops[j],
          edge: {
            to: destRoute.stops[j],
            weight: AVG_MIN_PER_SEGMENT,
            type: 'bus',
            routeId: destRoute.id,
            routeColor: destRoute.color,
            routeName: destRoute.name,
          },
        });
      }

      return { steps };
    }
  }
  return null;
}

// ─── Path → Legs ────────────────────────────────────────────────────────

function pathToLegs(steps, stopMap) {
  const legs = [];
  let curBusLeg = null;

  for (let i = 1; i < steps.length; i++) {
    const { stopId, edge } = steps[i];
    const prevStopId = steps[i - 1].stopId;

    if (edge.type === 'bus') {
      if (curBusLeg && curBusLeg.routeId === edge.routeId) {
        curBusLeg.stops.push({ id: stopId, name: (stopMap[stopId] || {}).name || stopId });
        curBusLeg.rideMin += edge.weight;
      } else {
        if (curBusLeg) legs.push(curBusLeg);
        curBusLeg = {
          type: 'bus',
          routeId: edge.routeId,
          routeColor: edge.routeColor,
          routeName: edge.routeName,
          rideMin: edge.weight,
          stops: [
            { id: prevStopId, name: (stopMap[prevStopId] || {}).name || prevStopId },
            { id: stopId,     name: (stopMap[stopId] || {}).name || stopId },
          ],
        };
      }
    } else {
      if (curBusLeg) { legs.push(curBusLeg); curBusLeg = null; }
      legs.push({
        type: edge.type,
        transferMin: edge.transferMin,
        distM: edge.distM,
        from: { id: prevStopId, name: (stopMap[prevStopId] || {}).name || prevStopId },
        to:   { id: stopId,     name: (stopMap[stopId] || {}).name || stopId },
      });
    }
  }
  if (curBusLeg) legs.push(curBusLeg);
  return legs;
}

// ─── Main Entry Point ───────────────────────────────────────────────────

async function planJourney(fromStop, toStop, arrivals, allRoutes, pool, allStops) {
  if (!allStops || allStops.length === 0) {
    return emptyResult(fromStop, toStop, 'Stop data could not be loaded.');
  }

  const { graph, stopMap } = buildTransitGraph(allRoutes, allStops);

  // Try Dijkstra first (natural walking transfers)
  let result = dijkstra(graph, fromStop.id, toStop.id);

  // Fallback: forced transfer for far-apart lines
  if (!result) {
    result = buildForcedTransferPath(fromStop, toStop, allRoutes, allStops);
  }

  if (!result) {
    return emptyResult(fromStop, toStop, 'No route found between these two stops.');
  }

  const legs = pathToLegs(result.steps, stopMap);
  if (legs.length === 0) {
    return emptyResult(fromStop, toStop, 'Route could not be built.');
  }

  // Enrich first bus leg with ML-predicted wait time
  const firstBusLeg = legs.find(l => l.type === 'bus');
  let waitMin = 0;
  let serviceEnded = false;
  let firstBusTimeStr = null;
  if (firstBusLeg) {
    const arrival = arrivals.find(a => a.routeId === firstBusLeg.routeId);
    if (arrival) {
      waitMin = arrival.predictedMin;
      serviceEnded = arrival.serviceEnded || false;
      firstBusTimeStr = arrival.firstBusTimeStr || null;
      firstBusLeg.waitMin = waitMin;
    }
  }

  // Total time = wait + all leg durations
  let totalMin = waitMin;
  for (const leg of legs) {
    if (leg.type === 'bus') {
      totalMin += leg.rideMin;
    } else {
      totalMin += leg.transferMin + TRANSFER_PENALTY;
    }
  }

  // Collect path coordinates for map
  const pathCoords = [];
  for (const leg of legs) {
    if (leg.type === 'bus') {
      for (const s of leg.stops) {
        const full = stopMap[s.id];
        if (full) pathCoords.push({ id: s.id, name: s.name, lat: full.lat, lng: full.lng, routeColor: leg.routeColor });
      }
    } else {
      const f = stopMap[leg.from.id];
      const t = stopMap[leg.to.id];
      if (f) pathCoords.push({ id: f.id, name: f.name, lat: f.lat, lng: f.lng, transfer: true });
      if (t) pathCoords.push({ id: t.id, name: t.name, lat: t.lat, lng: t.lng, transfer: true });
    }
  }

  const busStopCount = legs.filter(l => l.type === 'bus').reduce((s, l) => s + l.stops.length - 1, 0);
  const hasTransfer = legs.some(l => l.type !== 'bus');

  const recommendation = buildRecommendation({ totalMin, waitMin, legs, serviceEnded, hasTransfer });

  return {
    from: { id: fromStop.id, name: fromStop.name },
    to:   { id: toStop.id,   name: toStop.name },
    totalMin,
    waitMin,
    busStopCount,
    hasTransfer,
    serviceEnded,
    firstBusTimeStr,
    legs,
    pathCoords,
    recommendation,
    mlPowered: true,
  };
}

// ─── Recommendation ─────────────────────────────────────────────────────

function buildRecommendation({ totalMin, waitMin, legs, serviceEnded, hasTransfer }) {
  if (serviceEnded) {
    return { text: 'No service right now', icon: '🌙', priority: 'info' };
  }
  if (waitMin <= 2) {
    return { text: `Run! Arrive in ${totalMin} min`, icon: '🏃', priority: 'urgent' };
  }
  const dolmusLeg = legs.find(l => l.type === 'dolmus');
  if (dolmusLeg) {
    const km = (dolmusLeg.distM / 1000).toFixed(1);
    return { text: `${km}km minibus/taxi to transfer point`, icon: '🚐', priority: 'suggestion' };
  }
  if (hasTransfer && totalMin <= 40) {
    return { text: `With transfer but fast — ${totalMin} min total`, icon: '✅', priority: 'ok' };
  }
  if (!hasTransfer && totalMin <= 20) {
    return { text: `Short trip — ${totalMin} min total`, icon: '✅', priority: 'ok' };
  }
  return { text: `${waitMin} min wait, ${totalMin} min total`, icon: '🔄', priority: 'ok' };
}

function emptyResult(fromStop, toStop, message) {
  return {
    from: { id: fromStop.id, name: fromStop.name },
    to:   { id: toStop.id,   name: toStop.name },
    totalMin: null,
    legs: [],
    pathCoords: [],
    recommendation: null,
    message,
  };
}

module.exports = {
  planJourney,
  _internal: { buildTransitGraph, dijkstra, pathToLegs, haversineDistance, buildRecommendation, buildForcedTransferPath },
};
