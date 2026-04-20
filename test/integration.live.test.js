// Integration smoke tests — hit a running server at http://localhost:3050.
//
// These are black-box tests: no mocks, no supertest, no pool injection.
// The server must already be running (docker compose up or `npm start`).
// If it is not reachable, each test is skipped rather than failed — we
// do not want local `npm test` runs to go red when docker is off.
//
// Technique map:
//   * Equivalence partitioning — valid stop id / unknown stop id / missing stop id
//   * Response-shape validation (contract testing) — key presence + type
//   * Cross-endpoint invariants — e.g. options[bestOption] exists when bestOption >= 0

const test = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3050';
const PROBE_STOP = process.env.TEST_STOP_ID || 'STP-L01-04';

let serverReachable = null;

async function ensureReachable() {
  if (serverReachable !== null) return serverReachable;
  try {
    const r = await fetch(`${BASE}/api/model/info`, { signal: AbortSignal.timeout(1500) });
    serverReachable = r.ok;
  } catch {
    serverReachable = false;
  }
  return serverReachable;
}

async function skipIfOffline(t) {
  const up = await ensureReachable();
  if (!up) {
    t.skip(`server not reachable at ${BASE} — start it with \`docker compose up\` to run live tests`);
    return true;
  }
  return false;
}

// ─── /api/model/info ────────────────────────────────────────────────────
test('GET /api/model/info returns trained model metadata', async (t) => {
  if (await skipIfOffline(t)) return;

  const r = await fetch(`${BASE}/api/model/info`);
  assert.equal(r.status, 200);
  const body = await r.json();

  assert.equal(typeof body, 'object');
  assert.ok(body !== null, 'body should not be null');
  // Contract: these fields MUST exist or the UI loading state breaks
  assert.ok('initialized' in body, 'missing initialized flag');
  assert.ok('dataSource' in body, 'missing dataSource');
  // When initialized, models must carry metrics the footer renders
  if (body.initialized) {
    assert.ok(body.arrivalModel && typeof body.arrivalModel.mae === 'number', 'arrivalModel.mae missing');
    assert.ok(body.crowdModel && typeof body.crowdModel.accuracy === 'number', 'crowdModel.accuracy missing');
  }
});

// ─── /api/hackathon/stats ───────────────────────────────────────────────
test('GET /api/hackathon/stats returns non-zero CSV counts when loaded', async (t) => {
  if (await skipIfOffline(t)) return;

  const r = await fetch(`${BASE}/api/hackathon/stats`);
  assert.equal(r.status, 200);
  const body = await r.json();

  assert.equal(typeof body.loaded, 'boolean');
  assert.equal(typeof body.trips, 'number');
  assert.equal(typeof body.arrivals, 'number');
  assert.equal(typeof body.passengerFlow, 'number');
  assert.equal(typeof body.sivasStops, 'number');

  if (body.loaded) {
    // Sanity floors — the hackathon CSVs ship with tens of thousands of rows.
    // If these drop to near-zero, a CSV import step silently broke.
    assert.ok(body.trips > 1000, `trips unexpectedly low: ${body.trips}`);
    assert.ok(body.sivasStops > 50, `sivasStops unexpectedly low: ${body.sivasStops}`);
  }
});

// ─── /api/stops/:id/advice — valid stop ────────────────────────────────
test('GET /api/stops/:id/advice returns well-formed advice for a known Sivas stop', async (t) => {
  if (await skipIfOffline(t)) return;

  const r = await fetch(`${BASE}/api/stops/${PROBE_STOP}/advice`);
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  const body = await r.json();

  // Shape contract
  assert.equal(body.stopId, PROBE_STOP);
  assert.equal(typeof body.stopName, 'string');
  assert.ok(Array.isArray(body.options), 'options must be an array');
  assert.equal(typeof body.bestOption, 'number');
  assert.ok('crowd' in body);
  assert.ok('globalAdvice' in body);

  // Cross-field invariant: bestOption is either -1 (service-ended) OR a valid index
  if (body.bestOption !== -1) {
    assert.ok(
      body.bestOption >= 0 && body.bestOption < body.options.length,
      `bestOption ${body.bestOption} is out of range for ${body.options.length} options`
    );
  }

  // Every option must carry the keys the hero card reads
  for (const opt of body.options) {
    assert.ok('routeId' in opt);
    assert.ok('predictedMin' in opt);
    assert.ok('occupancyPct' in opt);
    assert.ok('stressScore' in opt);
    assert.ok('recommendation' in opt);
    assert.ok('serviceEnded' in opt, 'serviceEnded flag missing — night-wrap fix regressed');
    assert.ok('isLastBus' in opt);
    // Recommendation contract — the chip the user reads
    assert.equal(typeof opt.recommendation.action, 'string');
    assert.equal(typeof opt.recommendation.text, 'string');
    assert.equal(typeof opt.recommendation.priority, 'string');
  }

  // Night-wrap regression pinning: if any option is serviceEnded it MUST
  // carry a firstBusTimeStr so the UI hero has something to render.
  for (const opt of body.options) {
    if (opt.serviceEnded) {
      assert.ok(opt.firstBusTimeStr, 'serviceEnded option is missing firstBusTimeStr');
    }
  }

  // If all options are serviceEnded, bestOption MUST be -1 (previous bug: it showed a "best pick")
  const allEnded = body.options.length > 0 && body.options.every(o => o.serviceEnded);
  if (allEnded) {
    assert.equal(body.bestOption, -1, 'all-serviceEnded must suppress bestOption');
  }
});

// ─── /api/stops/:id/advice — unknown stop (error path) ─────────────────
test('GET /api/stops/:id/advice returns 404 for an unknown stop id', async (t) => {
  if (await skipIfOffline(t)) return;

  const r = await fetch(`${BASE}/api/stops/STP-DOES-NOT-EXIST-9999/advice`);
  assert.equal(r.status, 404);
  const body = await r.json();
  assert.ok(body.error, 'error message missing');
});
