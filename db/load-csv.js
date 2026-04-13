// ─── Hackathon CSV Data Loader ──────────────────────────────────────────
// Parses the 5 Sivas CSV files and bulk-inserts into the database.
// No external dependencies — uses built-in fs + readline.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_DIR = path.join(__dirname, '..', 'Given Data by hackathon team', 'predictive_transit_data');

// ─── CSV Parser ─────────────────────────────────────────────────────────

function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let headers = null;

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, 'utf8'),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      // Simple CSV split (no quoted commas in this dataset)
      const cols = trimmed.split(',');

      if (!headers) {
        headers = cols.map(h => h.trim());
        return;
      }

      const row = {};
      for (let i = 0; i < headers.length; i++) {
        row[headers[i]] = (cols[i] || '').trim();
      }
      rows.push(row);
    });

    rl.on('close', () => resolve(rows));
    rl.on('error', reject);
  });
}

// ─── Route Colors ───────────────────────────────────────────────────────

const LINE_COLORS = {
  L01: '#ef4444',
  L02: '#3b82f6',
  L03: '#f59e0b',
  L04: '#8b5cf6',
  L05: '#10b981',
};

// ─── Load Functions ─────────────────────────────────────────────────────

async function loadStops(pool, sivasCityId) {
  console.log('   📍 Loading bus stops...');
  const rows = await parseCSV(path.join(DATA_DIR, 'bus_stops.csv'));

  // Group by line to get stop name per line
  const lineNames = {};
  const stopMap = new Map(); // stopId -> { lat, lng, lineId, sequence, stopType, isTerminal }

  for (const row of rows) {
    lineNames[row.line_id] = row.line_name;

    if (!stopMap.has(row.stop_id)) {
      stopMap.set(row.stop_id, {
        lat: parseFloat(row.latitude),
        lng: parseFloat(row.longitude),
        stopType: row.stop_type,
        isTerminal: row.is_terminal === '1',
        lines: [],
      });
    }
    stopMap.get(row.stop_id).lines.push({
      lineId: row.line_id,
      lineName: row.line_name,
      sequence: parseInt(row.stop_sequence),
    });
  }

  // Insert stops
  for (const [stopId, info] of stopMap) {
    const name = `${info.stopType.charAt(0).toUpperCase() + info.stopType.slice(1)} ${stopId.split('-').pop()}`;
    const popularity = info.isTerminal ? 0.9 : (info.stopType === 'university' ? 0.85 : info.stopType === 'hospital' ? 0.8 : 0.6);
    const avgDelay = info.isTerminal ? 2.5 : 1.8;

    try {
      await pool.execute(
        'INSERT IGNORE INTO stops (id, city_id, name, lat, lng, popularity, avg_delay) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [stopId, sivasCityId, name, info.lat, info.lng, popularity, avgDelay]
      );
    } catch (err) {
      // Skip duplicates
    }
  }

  // Insert routes and route_stops
  const lineIds = Object.keys(lineNames);
  for (const lineId of lineIds) {
    const lineName = lineNames[lineId];
    const color = LINE_COLORS[lineId] || '#4f8cff';

    try {
      await pool.execute(
        'INSERT IGNORE INTO routes (id, city_id, name, color) VALUES (?, ?, ?, ?)',
        [lineId, sivasCityId, lineName, color]
      );
    } catch (err) {
      // Skip duplicates
    }

    // Get stops on this line, sorted by sequence
    const lineStops = rows
      .filter(r => r.line_id === lineId)
      .sort((a, b) => parseInt(a.stop_sequence) - parseInt(b.stop_sequence));

    for (const stop of lineStops) {
      try {
        await pool.execute(
          'INSERT IGNORE INTO route_stops (route_id, stop_id, stop_order) VALUES (?, ?, ?)',
          [lineId, stop.stop_id, parseInt(stop.stop_sequence) - 1]
        );
      } catch (err) {
        // Skip duplicates
      }
    }
  }

  console.log(`   ✅ Loaded ${stopMap.size} stops, ${lineIds.length} routes`);
}

async function loadTrips(pool) {
  console.log('   🚌 Loading bus trips...');
  const rows = await parseCSV(path.join(DATA_DIR, 'bus_trips.csv'));

  // Batch insert
  const BATCH = 500;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values = [];
    const placeholders = [];

    for (const r of batch) {
      placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      values.push(
        r.trip_id,
        r.line_id,
        r.line_name,
        r.day_of_week === '' ? null : r.day_of_week, // direction is missing in our CSV
        parseInt(r.day_of_week) || 0,
        parseInt(r.is_weekend) || 0,
        '', // time_of_day placeholder
        r.planned_departure ? r.planned_departure.split(' ')[1] || null : null,
        r.actual_departure ? r.actual_departure.split(' ')[1] || null : null,
        parseFloat(r.departure_delay_min) || 0,
        parseFloat(r.planned_duration_min) || 0,
        parseFloat(r.actual_duration_min) || 0,
        r.weather_condition || '',
        parseFloat(r.temperature_c) || 0,
        parseFloat(r.precipitation_mm) || 0,
        parseFloat(r.wind_speed_kmh) || 0,
        r.traffic_level || '',
        parseFloat(r.speed_factor) || 1,
        parseInt(r.num_stops) || 0,
        parseFloat(r.avg_occupancy_pct) || 0,
      );
    }

    await pool.execute(
      `INSERT INTO hackathon_trips (trip_id, line_id, line_name, direction, day_of_week, is_weekend, time_of_day, planned_departure, actual_departure, departure_delay_min, planned_duration_min, actual_duration_min, weather_condition, temperature_c, precipitation_mm, wind_speed_kmh, traffic_level, speed_factor, num_stops, avg_occupancy_pct) VALUES ${placeholders.join(',')}`,
      values
    );
    inserted += batch.length;
  }

  console.log(`   ✅ Loaded ${inserted} trips`);
}

async function loadArrivals(pool) {
  console.log('   📊 Loading stop arrivals...');
  const rows = await parseCSV(path.join(DATA_DIR, 'stop_arrivals.csv'));

  const BATCH = 500;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values = [];
    const placeholders = [];

    for (const r of batch) {
      placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      values.push(
        r.observation_id,
        r.trip_id,
        r.line_id,
        r.stop_id,
        parseInt(r.stop_sequence) || 0,
        r.planned_arrival ? r.planned_arrival.split(' ')[1] || null : null,
        r.actual_arrival ? r.actual_arrival.split(' ')[1] || null : null,
        parseFloat(r.delay_min) || 0,
        parseInt(r.passengers_waiting) || 0,
        parseInt(r.passengers_boarding) || 0,
        parseInt(r.passengers_alighting) || 0,
        parseFloat(r.dwell_time_min) || 0,
        parseFloat(r.cumulative_delay_min) || 0,
        r.weather_condition || '',
        parseFloat(r.temperature_c) || 0,  // not in CSV, use from trip
        parseFloat(r.speed_factor) || 1,
        parseFloat(r.minutes_to_next_bus) || 0,
      );
    }

    await pool.execute(
      `INSERT INTO hackathon_arrivals (arrival_id, trip_id, line_id, stop_id, stop_sequence, scheduled_arrival, actual_arrival, delay_min, passengers_waiting, passengers_boarding, passengers_alighting, dwell_time_min, cumulative_delay_min, weather_condition, temperature_c, speed_factor, minutes_to_next_bus) VALUES ${placeholders.join(',')}`,
      values
    );
    inserted += batch.length;
  }

  console.log(`   ✅ Loaded ${inserted} arrival observations`);
}

async function loadPassengerFlow(pool) {
  console.log('   👥 Loading passenger flow...');
  const rows = await parseCSV(path.join(DATA_DIR, 'passenger_flow.csv'));

  const BATCH = 500;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values = [];
    const placeholders = [];

    for (const r of batch) {
      placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      values.push(
        r.stop_id,
        r.line_id,
        r.stop_type || '',
        parseInt(r.hour_of_day) || 0,
        parseInt(r.day_of_week) || 0,
        parseInt(r.is_weekend) || 0,
        r.time_bucket || '',
        r.weather_condition || '',
        parseFloat(r.avg_passengers_waiting) || 0,
        parseFloat(r.avg_passengers_boarding) || 0,
        parseFloat(r.avg_dwell_time_min) || 0,
        parseInt(r.sample_count) || 0,
        parseFloat(r.std_passengers_waiting) || 0,
        parseInt(r.max_passengers_waiting) || 0,
        r.crowding_level || '',
      );
    }

    await pool.execute(
      `INSERT INTO hackathon_passenger_flow (stop_id, line_id, stop_type, hour_of_day, day_of_week, is_weekend, time_bucket, weather_condition, avg_passengers_waiting, avg_passengers_boarding, avg_dwell_time_min, sample_count, std_passengers_waiting, max_passengers_waiting, crowding_level) VALUES ${placeholders.join(',')}`,
      values
    );
    inserted += batch.length;
  }

  console.log(`   ✅ Loaded ${inserted} passenger flow records`);
}

// ─── Main Loader ────────────────────────────────────────────────────────

async function loadHackathonData(pool) {
  // Check if already loaded
  const [existingStops] = await pool.execute(
    `SELECT COUNT(*) as cnt FROM stops s JOIN cities c ON s.city_id = c.id WHERE LOWER(c.name) = 'sivas'`
  );

  if (existingStops[0].cnt > 0) {
    console.log('   ℹ️ Sivas data already loaded, skipping CSV import.');
    return false;
  }

  // Check if CSV files exist
  if (!fs.existsSync(path.join(DATA_DIR, 'bus_stops.csv'))) {
    console.log('   ⚠️ Hackathon CSV files not found, skipping import.');
    return false;
  }

  // Get Sivas city ID
  const [[sivasRow]] = await pool.execute("SELECT id FROM cities WHERE LOWER(name) = 'sivas'");
  if (!sivasRow) {
    console.log('   ⚠️ Sivas city not found in DB, skipping CSV import.');
    return false;
  }

  const sivasCityId = sivasRow.id;
  console.log('\n📂 Loading hackathon CSV data for Sivas...');
  const start = Date.now();

  await loadStops(pool, sivasCityId);
  await loadTrips(pool);
  await loadArrivals(pool);
  await loadPassengerFlow(pool);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`📂 All hackathon data loaded in ${elapsed}s\n`);
  return true;
}

module.exports = { loadHackathonData };
