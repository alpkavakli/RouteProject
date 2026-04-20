// ─── Smart Advisor Engine ───────────────────────────────────────────────
// Generates actionable transit recommendations for a given stop:
// - Stress scoring
// - Seat availability & turnover predictions  
// - Wait/board recommendations
// - Last bus warnings
// - Reverse route suggestions

/**
 * Generate advice for all incoming buses at a stop
 * @param {Object} stop - Stop object { id, name, routes, popularity, avg_delay }
 * @param {Array} arrivals - Arrival predictions from predictor.predictArrivals()
 * @param {Object} crowd - Crowd prediction from predictor.predictCrowd()
 * @param {Object} pool - MySQL connection pool  
 * @param {Array} allRoutes - All routes in the city
 * @returns {Object} Advice response
 */
async function generateAdvice(stop, arrivals, crowd, pool, allRoutes) {
  // Load historical seat turnover data for this stop
  let seatData = {};

  try {
    seatData = await loadSeatTurnoverData(pool, stop.id);
  } catch (err) {
    // Graceful degradation — still provide basic advice without DB data
    console.log(`   ⚠️ Advisor DB query failed: ${err.message}`);
  }

  const options = arrivals.map((arrival, idx) => {
    const routeId = arrival.routeId;
    const route = allRoutes.find(r => r.id === routeId);
    const stopSequence = route ? (route.stops || []).indexOf(stop.id) : -1;
    const totalStops = route ? (route.stops || []).length : 10;
    const remainingStops = Math.max(0, totalStops - stopSequence - 1);

    // ─── Occupancy Estimation ────────────────────────────────────────
    // Prefer the real trip average from hackathon_trips; fall back to an
    // ML-class-derived estimate blended with stop-level history.
    const occupancyPct = (arrival.realOccupancyPct != null && !Number.isNaN(arrival.realOccupancyPct))
      ? arrival.realOccupancyPct
      : estimateOccupancy(arrival, seatData[routeId]);
    const busCapacity = arrival.busCapacity || 60;
    const seatsAvailable = Math.max(0, Math.round(busCapacity * (1 - occupancyPct / 100)));

    // ─── Seat Turnover ───────────────────────────────────────────────
    const turnover = analyzeSeatTurnover(seatData[routeId], stopSequence);

    // ─── Stress Score ────────────────────────────────────────────────
    const now = new Date();
    const hour = now.getHours();
    const isWeekday = now.getDay() >= 1 && now.getDay() <= 5;
    const isRushHour = isWeekday && ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19));

    const stress = computeStress({
      occupancyPct,
      delayMin: Math.max(0, arrival.delayMin),
      isRushHour,
      precipitation: 0, // we'd need weather, use 0 as default
      speedFactor: arrival.realSpeedFactor || 1,
      remainingStops,
    });

    // ─── Service State ───────────────────────────────────────────────
    // Service has ended for tonight: the predictor already wrapped to
    // tomorrow's first trip for this line. That is NOT a "last bus".
    const serviceEnded = !!arrival.serviceEnded;
    const isLastBus = !serviceEnded && !!arrival.isLastTripToday;

    // ─── Next Bus Comparison ─────────────────────────────────────────
    // Prefer the real "minutes to next bus" from the hackathon schedule.
    // Occupancy of the next bus is assumed ~70% of this bus's real average.
    const minutesToNextBus = arrival.realNextBusMin != null
      ? arrival.realNextBusMin
      : (() => {
          const nextBus = arrivals.find((a, i) => i > idx && a.routeId === routeId);
          return nextBus ? nextBus.predictedMin - arrival.predictedMin : null;
        })();
    const nextBusOccupancyPct = minutesToNextBus != null ? occupancyPct * 0.7 : null;

    // ─── Recommendation Generation ───────────────────────────────────
    const recommendation = generateRecommendation({
      arrival,
      occupancyPct,
      seatsAvailable,
      isLastBus,
      serviceEnded,
      minutesToNextBus,
      nextBusOccupancyPct,
      turnover,
      stress,
      stopSequence,
      remainingStops,
    });

    return {
      routeId: arrival.routeId,
      routeName: arrival.routeName,
      routeColor: arrival.routeColor,
      destination: arrival.destination,
      predictedMin: arrival.predictedMin,
      scheduledMin: arrival.scheduledMin,
      delayMin: arrival.delayMin,
      status: arrival.status,
      confidence: arrival.confidence,
      vehicleId: arrival.vehicleId,
      factors: arrival.factors,
      // New advice fields
      crowdLevel: arrival.occupancy,
      occupancyPct: Math.round(occupancyPct),
      seatsAvailable,
      seatTurnover: turnover.level,
      seatTurnoverNote: turnover.note,
      stressScore: stress.score,
      stressLabel: stress.label,
      isLastBus,
      serviceEnded,
      firstBusTimeStr: arrival.firstBusTimeStr || null,
      lastBusTimeStr: arrival.lastBusTimeStr || null,
      minutesToNextBus,
      futureBusMins: Array.isArray(arrival.realFutureBusMins) ? arrival.realFutureBusMins : null,
      nextBusOccupancyPct: nextBusOccupancyPct ? Math.round(nextBusOccupancyPct) : null,
      recommendation,
      mlPowered: true,
    };
  });

  // Find best option (lowest stress + available seats + reasonable wait).
  // When all options are tomorrow's first trip (service ended), there is no
  // "best pick" — every card is just informational.
  const allServiceEnded = options.length > 0 && options.every(o => o.serviceEnded);
  const bestIdx = allServiceEnded ? -1 : findBestOption(options);

  return {
    stopId: stop.id,
    stopName: stop.name,
    options,
    bestOption: bestIdx,
    crowd,
    globalAdvice: generateGlobalAdvice(options, crowd),
  };
}

// ─── Sub-functions ──────────────────────────────────────────────────────

function estimateOccupancy(arrival, routeSeatData) {
  // Base from crowd level
  const levelMap = {
    empty: 10, light: 25, moderate: 45, busy: 65, crowded: 85,
    low: 20, medium: 50, high: 80,
  };
  let base = levelMap[arrival.occupancy] || 50;

  // Adjust by delay (more delay → more accumulated passengers)
  if (arrival.delayMin > 2) base += Math.min(15, arrival.delayMin * 3);

  // Use historical avg if available
  if (routeSeatData && routeSeatData.avgOccupancy) {
    base = base * 0.4 + routeSeatData.avgOccupancy * 0.6;
  }

  return Math.min(100, Math.max(0, base));
}

function analyzeSeatTurnover(routeSeatData, stopSequence) {
  if (!routeSeatData || !routeSeatData.avgAlightingNext3) {
    return { level: 'unknown', note: null };
  }

  const avgAlighting = routeSeatData.avgAlightingNext3;

  if (avgAlighting > 25) {
    return {
      level: 'high',
      note: `${Math.round(avgAlighting)} passengers getting off soon — you'll get a seat within 3 stops`,
    };
  } else if (avgAlighting > 15) {
    return {
      level: 'moderate',
      note: `Seats will free up soon — ~${Math.round(avgAlighting)} alighting`,
    };
  } else if (avgAlighting > 5) {
    return {
      level: 'low',
      note: `Some seat turnover — ${Math.round(avgAlighting)} getting off`,
    };
  }

  return { level: 'very_low', note: null };
}

function computeStress({ occupancyPct, delayMin, isRushHour, precipitation, speedFactor, remainingStops }) {
  const score = Math.round(
    (occupancyPct / 100) * 35 +
    Math.min(delayMin / 20, 1) * 20 +
    (isRushHour ? 15 : 0) +
    (precipitation > 10 ? 10 : 0) +
    (1 - (speedFactor || 1)) * 10 +
    (remainingStops > 10 ? 10 : 0)
  );

  const clampedScore = Math.max(0, Math.min(100, score));

  let label;
  if (clampedScore < 30) label = 'Relaxed';
  else if (clampedScore < 50) label = 'Normal';
  else if (clampedScore < 70) label = 'Busy';
  else label = 'Stressful';

  return { score: clampedScore, label };
}

function generateRecommendation({ arrival, occupancyPct, seatsAvailable, isLastBus, serviceEnded, minutesToNextBus, nextBusOccupancyPct, turnover, stress, stopSequence, remainingStops }) {
  // Priority 0: Service gap — next trip is hours away (night / pre-dawn)
  if (serviceEnded) {
    const firstBus = arrival.firstBusTimeStr;
    return {
      action: 'service-ended',
      text: firstBus
        ? `No service right now — first bus at ${firstBus}`
        : `No service right now — first bus in the morning`,
      icon: '🌙',
      priority: 'info',
    };
  }

  // Priority 1: Urgency — bus arriving very soon
  if (arrival.predictedMin <= 2) {
    return {
      action: 'run',
      text: `Run! Bus leaves in ${arrival.predictedMin} min`,
      icon: '🏃',
      priority: 'urgent',
    };
  }

  // Priority 2: Last bus warning
  if (isLastBus) {
    const lastBus = arrival.lastBusTimeStr;
    return {
      action: 'board',
      text: lastBus
        ? `⚠️ Last bus (${lastBus}) — no more service tonight`
        : `⚠️ Last bus — no more service tonight`,
      icon: '⚠️',
      priority: 'critical',
    };
  }

  // Priority 3: Wait suggestion (next bus is significantly emptier)
  if (minutesToNextBus && minutesToNextBus <= 12 && nextBusOccupancyPct !== null) {
    const occupancyDiff = occupancyPct - nextBusOccupancyPct;
    if (occupancyDiff > 20) {
      return {
        action: 'wait',
        text: `Wait ${minutesToNextBus} min — next bus is emptier (${Math.round(nextBusOccupancyPct)}% full)`,
        icon: '⏳',
        priority: 'suggestion',
      };
    }
  }

  // Priority 4: Seat turnover hint
  if (seatsAvailable <= 5 && turnover.level === 'high') {
    return {
      action: 'board',
      text: turnover.note || 'Seats will free up soon',
      icon: '🪑',
      priority: 'info',
    };
  }

  // Priority 5: Reverse route suggestion (for long journeys)
  if (stopSequence > 2 && remainingStops > 12 && occupancyPct > 70) {
    return {
      action: 'alternative',
      text: `Go to the origin stop — board an empty bus (2 stops back)`,
      icon: '🔄',
      priority: 'suggestion',
    };
  }

  // Default: Board if stress is ok
  if (stress.score < 50) {
    return {
      action: 'board',
      text: `Board — stress is low`,
      icon: '✅',
      priority: 'ok',
    };
  }

  // High stress but no better option
  return {
    action: 'board',
    text: `Crowded but no alternative — board`,
    icon: '😤',
    priority: 'warning',
  };
}

function findBestOption(options) {
  if (options.length === 0) return 0;

  let bestIdx = 0;
  let bestScore = Infinity;

  options.forEach((opt, i) => {
    // Lower is better: stress * 0.4 + wait * 0.3 + occupancy * 0.3
    const score = opt.stressScore * 0.4 +
                  opt.predictedMin * 0.3 * 5 +  // normalize to ~0-100
                  opt.occupancyPct * 0.3;
    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  });

  return bestIdx;
}

function generateGlobalAdvice(options, crowd) {
  if (options.length === 0) return 'No service info available right now.';

  const allServiceEnded = options.every(o => o.serviceEnded);
  if (allServiceEnded) {
    const firstBus = options.map(o => o.firstBusTimeStr).filter(Boolean).sort()[0];
    return firstBus
      ? `🌙 No service — first bus at ${firstBus}`
      : '🌙 No service — first bus tomorrow morning';
  }

  const hasLastBus = options.some(o => o.isLastBus);
  if (hasLastBus) return '⚠️ Last buses approaching — don\'t miss them!';

  const allCrowded = options.every(o => o.stressScore > 60);
  if (allCrowded) return '😰 All buses are crowded — pick the lowest-stress one.';

  const bestOpt = options[findBestOption(options)];
  if (bestOpt && bestOpt.stressScore < 30) {
    return `✅ Good conditions — line ${bestOpt.routeId} recommended.`;
  }

  return null;
}

// ─── Database Queries ───────────────────────────────────────────────────

async function loadSeatTurnoverData(pool, stopId) {
  try {
    // Single query: per-line averages + next-3-stop alighting via self-JOIN
    // (was N+1: 1 GROUP BY query + 1 subquery per line)
    const [rows] = await pool.execute(`
      SELECT
        a.line_id,
        AVG(a.passengers_alighting) AS avg_alighting,
        AVG(a.passengers_boarding) AS avg_boarding,
        AVG(a.passengers_waiting) AS avg_waiting,
        (
          SELECT AVG(a2.passengers_alighting)
          FROM hackathon_arrivals a2
          WHERE a2.line_id = a.line_id
            AND a2.stop_sequence > (SELECT AVG(a3.stop_sequence) FROM hackathon_arrivals a3 WHERE a3.stop_id = ? AND a3.line_id = a.line_id)
            AND a2.stop_sequence <= (SELECT AVG(a3.stop_sequence) + 3 FROM hackathon_arrivals a3 WHERE a3.stop_id = ? AND a3.line_id = a.line_id)
        ) AS avg_next_alighting
      FROM hackathon_arrivals a
      WHERE a.stop_id = ?
      GROUP BY a.line_id
    `, [stopId, stopId, stopId]);

    const result = {};
    for (const r of rows) {
      result[r.line_id] = {
        avgOccupancy: Math.min(100, (r.avg_waiting || 0) / 60 * 100),
        avgAlightingNext3: r.avg_next_alighting || 0,
      };
    }
    return result;
  } catch (err) {
    return {};
  }
}

async function loadFlowAverages(pool, stopId) {
  try {
    const [rows] = await pool.execute(`
      SELECT 
        line_id,
        AVG(avg_passengers_waiting) as avg_waiting,
        AVG(avg_passengers_boarding) as avg_boarding
      FROM hackathon_passenger_flow
      WHERE stop_id = ?
      GROUP BY line_id
    `, [stopId]);

    const result = {};
    for (const r of rows) {
      result[r.line_id] = {
        avgWaiting: r.avg_waiting || 0,
        avgBoarding: r.avg_boarding || 0,
      };
    }
    return result;
  } catch (err) {
    return {};
  }
}

module.exports = {
  generateAdvice,
  // Exposed for unit testing (pure helpers, no DB / no globals)
  _internal: {
    estimateOccupancy,
    analyzeSeatTurnover,
    computeStress,
    generateRecommendation,
    findBestOption,
    generateGlobalAdvice,
  },
};
