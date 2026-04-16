'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const predictor = require('./ml/predictor');
const advisor = require('./ml/advisor');
const { initDatabase } = require('./db/init');
const { loadHackathonData, ensureSivasWeatherSeeded } = require('./db/load-csv');

const app = express();
const PORT = process.env.PORT || 3000;

let pool; // set after DB init

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));   // security headers (CSP off for CDN tiles/fonts)
app.use(compression());                              // gzip all responses (~60-70% smaller JSON)
app.use(cors());
app.use(express.json());

// Request timing — logs API latency to console
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function (statusCode, ...args) {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    res.setHeader('X-Response-Time', `${ms.toFixed(1)}ms`);
    return origWriteHead(statusCode, ...args);
  };
  res.on('finish', () => {
    if (req.path.startsWith('/api/')) {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      console.log(`  ${req.method} ${req.path} → ${res.statusCode} (${ms.toFixed(1)}ms)`);
    }
  });
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',                                      // cache static assets for 1 hour
  etag: true,
}));

// ─── Helper: query stops with their route IDs ─────────────────────────────

async function queryStops(filter) {
  let query = `
    SELECT s.id, s.name, s.lat, s.lng, s.popularity, s.avg_delay,
           c.name AS city,
           GROUP_CONCAT(rs.route_id ORDER BY rs.stop_order) AS route_ids
    FROM stops s
    JOIN cities c ON s.city_id = c.id
    LEFT JOIN route_stops rs ON s.id = rs.stop_id
  `;
  const params = [];

  if (filter.city) {
    query += ' WHERE LOWER(c.name) = LOWER(?)';
    params.push(filter.city);
  } else if (filter.id) {
    query += ' WHERE s.id = ?';
    params.push(filter.id);
  }

  query += ' GROUP BY s.id, s.name, s.lat, s.lng, s.popularity, s.avg_delay, c.name';

  const [rows] = await pool.execute(query, params);
  return rows.map(r => ({
    id: r.id,
    city: r.city,
    name: r.name,
    lat: r.lat,
    lng: r.lng,
    popularity: r.popularity,
    avg_delay: r.avg_delay,
    routes: r.route_ids ? r.route_ids.split(',') : [],
  }));
}

async function queryRoutes(filter) {
  let query = `
    SELECT r.id, r.name, r.color, c.name AS city,
           GROUP_CONCAT(rs.stop_id ORDER BY rs.stop_order) AS stop_ids
    FROM routes r
    JOIN cities c ON r.city_id = c.id
    LEFT JOIN route_stops rs ON r.id = rs.route_id
  `;
  const params = [];

  if (filter.city) {
    query += ' WHERE LOWER(c.name) = LOWER(?)';
    params.push(filter.city);
  } else if (filter.id) {
    query += ' WHERE r.id = ?';
    params.push(filter.id);
  }

  query += ' GROUP BY r.id, r.name, r.color, c.name';

  const [rows] = await pool.execute(query, params);
  return rows.map(r => ({
    id: r.id,
    city: r.city,
    name: r.name,
    color: r.color,
    stops: r.stop_ids ? r.stop_ids.split(',') : [],
  }));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Shared weather loader (DRY) ──────────────────────────────────────────

async function ensureWeatherLoaded(city) {
  const [wRows] = await pool.execute(
    `SELECT w.*, c.name AS city FROM weather w
     JOIN cities c ON w.city_id = c.id
     WHERE LOWER(c.name) = LOWER(?)
     ORDER BY w.created_at DESC LIMIT 1`,
    [city]
  );
  if (wRows.length > 0) {
    predictor.setWeather({ temp: wRows[0].temp, precipitation: wRows[0].precipitation, windSpeed: wRows[0].wind_speed });
  } else {
    predictor.setWeather(generateRandomWeather(city));
  }
}

// ─── Cities ────────────────────────────────────────────────────────────────

app.get('/api/cities', async (req, res) => {
  try {
    const [cities] = await pool.execute('SELECT * FROM cities ORDER BY name');
    res.json(cities);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cities', async (req, res) => {
  try {
    const { name, lat, lng, zoom } = req.body;
    if (!name || lat == null || lng == null) {
      return res.status(400).json({ error: 'name, lat, and lng are required' });
    }
    const [result] = await pool.execute(
      'INSERT INTO cities (name, lat, lng, zoom) VALUES (?, ?, ?, ?)',
      [name, lat, lng, zoom || 13]
    );
    res.status(201).json({ id: result.insertId, name, lat, lng, zoom: zoom || 13 });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'City already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/cities/:id', async (req, res) => {
  try {
    const { name, lat, lng, zoom } = req.body;
    const [result] = await pool.execute(
      'UPDATE cities SET name = COALESCE(?, name), lat = COALESCE(?, lat), lng = COALESCE(?, lng), zoom = COALESCE(?, zoom) WHERE id = ?',
      [name, lat, lng, zoom, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'City not found' });
    res.json({ message: 'City updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/cities/:id', async (req, res) => {
  try {
    const [result] = await pool.execute('DELETE FROM cities WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'City not found' });
    res.json({ message: 'City deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Stops ─────────────────────────────────────────────────────────────────

app.get('/api/stops', async (req, res) => {
  try {
    const stops = await queryStops({ city: req.query.city });
    res.json(stops);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stops/:id', async (req, res) => {
  try {
    const stops = await queryStops({ id: req.params.id });
    if (stops.length === 0) return res.status(404).json({ error: 'Stop not found' });
    res.json(stops[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stops', async (req, res) => {
  try {
    const { id, city, name, lat, lng, popularity, avg_delay } = req.body;
    if (!id || !city || !name || lat == null || lng == null) {
      return res.status(400).json({ error: 'id, city, name, lat, and lng are required' });
    }
    const [[cityRow]] = await pool.execute('SELECT id FROM cities WHERE LOWER(name) = LOWER(?)', [city]);
    if (!cityRow) return res.status(404).json({ error: `City "${city}" not found. Create it first via POST /api/cities` });

    await pool.execute(
      'INSERT INTO stops (id, city_id, name, lat, lng, popularity, avg_delay) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, cityRow.id, name, lat, lng, popularity || 0.5, avg_delay || 2.0]
    );
    res.status(201).json({ id, city, name, lat, lng, popularity: popularity || 0.5, avg_delay: avg_delay || 2.0 });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Stop ID already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/stops/:id', async (req, res) => {
  try {
    const { name, lat, lng, popularity, avg_delay } = req.body;
    const [result] = await pool.execute(
      'UPDATE stops SET name = COALESCE(?, name), lat = COALESCE(?, lat), lng = COALESCE(?, lng), popularity = COALESCE(?, popularity), avg_delay = COALESCE(?, avg_delay) WHERE id = ?',
      [name, lat, lng, popularity, avg_delay, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Stop not found' });
    res.json({ message: 'Stop updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/stops/:id', async (req, res) => {
  try {
    const [result] = await pool.execute('DELETE FROM stops WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Stop not found' });
    res.json({ message: 'Stop deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Routes ────────────────────────────────────────────────────────────────

app.get('/api/routes', async (req, res) => {
  try {
    const routes = await queryRoutes({ city: req.query.city });
    res.json(routes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/routes', async (req, res) => {
  try {
    const { id, city, name, color, stops } = req.body;
    if (!id || !city || !name) {
      return res.status(400).json({ error: 'id, city, and name are required' });
    }
    const [[cityRow]] = await pool.execute('SELECT id FROM cities WHERE LOWER(name) = LOWER(?)', [city]);
    if (!cityRow) return res.status(404).json({ error: `City "${city}" not found` });

    await pool.execute(
      'INSERT INTO routes (id, city_id, name, color) VALUES (?, ?, ?, ?)',
      [id, cityRow.id, name, color || '#4f8cff']
    );

    if (stops && stops.length > 0) {
      for (let i = 0; i < stops.length; i++) {
        await pool.execute(
          'INSERT INTO route_stops (route_id, stop_id, stop_order) VALUES (?, ?, ?)',
          [id, stops[i], i]
        );
      }
    }

    res.status(201).json({ id, city, name, color: color || '#4f8cff', stops: stops || [] });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Route ID already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/routes/:id', async (req, res) => {
  try {
    const { name, color, stops } = req.body;
    const [result] = await pool.execute(
      'UPDATE routes SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?',
      [name, color, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Route not found' });

    // If stops array provided, replace the stop ordering
    if (stops) {
      await pool.execute('DELETE FROM route_stops WHERE route_id = ?', [req.params.id]);
      for (let i = 0; i < stops.length; i++) {
        await pool.execute(
          'INSERT INTO route_stops (route_id, stop_id, stop_order) VALUES (?, ?, ?)',
          [req.params.id, stops[i], i]
        );
      }
    }

    res.json({ message: 'Route updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/routes/:id', async (req, res) => {
  try {
    const [result] = await pool.execute('DELETE FROM routes WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Route not found' });
    res.json({ message: 'Route deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Weather ───────────────────────────────────────────────────────────────

app.get('/api/weather', async (req, res) => {
  try {
    const cityName = req.query.city || 'Istanbul';

    // Try to get the latest weather from DB
    const [rows] = await pool.execute(
      `SELECT w.*, c.name AS city FROM weather w
       JOIN cities c ON w.city_id = c.id
       WHERE LOWER(c.name) = LOWER(?)
       ORDER BY w.created_at DESC LIMIT 1`,
      [cityName]
    );

    let weather;
    if (rows.length > 0) {
      const r = rows[0];
      weather = {
        city: r.city,
        label: r.label,
        icon: r.icon,
        temp: r.temp,
        humidity: r.humidity,
        windSpeed: r.wind_speed,
        precipitation: r.precipitation,
        feelsLike: r.feels_like,
      };
    } else {
      // No weather in DB — generate random
      weather = generateRandomWeather(cityName);
    }

    // Feed to ML predictor
    predictor.setWeather(weather);
    res.json(weather);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/weather', async (req, res) => {
  try {
    const { city, label, icon, temp, humidity, windSpeed, precipitation, feelsLike } = req.body;
    if (!city || !label || !icon || temp == null || humidity == null || windSpeed == null) {
      return res.status(400).json({ error: 'city, label, icon, temp, humidity, and windSpeed are required' });
    }
    const [[cityRow]] = await pool.execute('SELECT id FROM cities WHERE LOWER(name) = LOWER(?)', [city]);
    if (!cityRow) return res.status(404).json({ error: `City "${city}" not found` });

    await pool.execute(
      'INSERT INTO weather (city_id, label, icon, temp, humidity, wind_speed, precipitation, feels_like) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [cityRow.id, label, icon, temp, humidity, windSpeed, precipitation || 0, feelsLike || temp]
    );

    const weather = { city, label, icon, temp, humidity, windSpeed, precipitation: precipitation || 0, feelsLike: feelsLike || temp };
    predictor.setWeather(weather);
    res.status(201).json(weather);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function generateRandomWeather(city) {
  const conditions = [
    { label: 'Clear', icon: 'sunny', temp: randomBetween(18, 30) },
    { label: 'Partly Cloudy', icon: 'partly_cloudy', temp: randomBetween(14, 24) },
    { label: 'Rainy', icon: 'rainy', temp: randomBetween(8, 18) },
    { label: 'Overcast', icon: 'cloudy', temp: randomBetween(10, 20) },
    { label: 'Windy', icon: 'windy', temp: randomBetween(12, 22) },
  ];
  const cond = conditions[randomBetween(0, conditions.length - 1)];
  return {
    city,
    ...cond,
    humidity: randomBetween(40, 85),
    windSpeed: randomBetween(5, 35),
    precipitation: cond.label === 'Rainy' ? randomBetween(20, 80) : randomBetween(0, 10),
    feelsLike: cond.temp + randomBetween(-3, 2),
  };
}

// ─── ML Predictions ────────────────────────────────────────────────────────

app.get('/api/stops/:id/arrivals', async (req, res) => {
  try {
    const stops = await queryStops({ id: req.params.id });
    if (stops.length === 0) return res.status(404).json({ error: 'Stop not found' });
    const stop = stops[0];

    await ensureWeatherLoaded(stop.city);
    const routes = await queryRoutes({ city: stop.city });
    const arrivals = await predictor.predictArrivals(stop, routes, pool);
    res.json(arrivals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stops/:id/crowd', async (req, res) => {
  try {
    const stops = await queryStops({ id: req.params.id });
    if (stops.length === 0) return res.status(404).json({ error: 'Stop not found' });
    const stop = stops[0];

    await ensureWeatherLoaded(stop.city);
    const routes = await queryRoutes({ city: stop.city });
    const arrivals = await predictor.predictArrivals(stop, routes, pool);
    const crowd = predictor.predictCrowd(stop, arrivals);
    res.json(crowd);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Smart Advice Endpoint ──────────────────────────────────────────────

app.get('/api/stops/:id/advice', async (req, res) => {
  try {
    const stops = await queryStops({ id: req.params.id });
    if (stops.length === 0) return res.status(404).json({ error: 'Stop not found' });
    const stop = stops[0];

    await ensureWeatherLoaded(stop.city);
    const routes = await queryRoutes({ city: stop.city });
    const arrivals = await predictor.predictArrivals(stop, routes, pool);
    const crowd = predictor.predictCrowd(stop, arrivals);

    const advice = await advisor.generateAdvice(stop, arrivals, crowd, pool, routes);
    res.json(advice);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Hackathon Stats ────────────────────────────────────────────────────

app.get('/api/hackathon/stats', async (req, res) => {
  try {
    // Single round-trip instead of 4 sequential COUNT queries
    const [rows] = await pool.execute(
      `SELECT 'trips' AS tbl, COUNT(*) AS cnt FROM hackathon_trips
       UNION ALL SELECT 'arrivals', COUNT(*) FROM hackathon_arrivals
       UNION ALL SELECT 'flow', COUNT(*) FROM hackathon_passenger_flow
       UNION ALL SELECT 'stops', COUNT(*) FROM stops s JOIN cities c ON s.city_id = c.id WHERE LOWER(c.name) = 'sivas'`
    );
    const counts = {};
    for (const r of rows) counts[r.tbl] = r.cnt;

    res.json({
      loaded: counts.trips > 0,
      trips: counts.trips,
      arrivals: counts.arrivals,
      passengerFlow: counts.flow,
      sivasStops: counts.stops,
      dataSource: predictor.getModelInfo().dataSource,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ML model info endpoint
app.get('/api/model/info', (req, res) => {
  res.json(predictor.getModelInfo());
});

// SPA fallback
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start Server ───────────────────────────────────────────────────────────

// Health check (for container orchestration / uptime monitoring)
let serverReady = false;
app.get('/api/health', (req, res) => {
  res.json({
    status: serverReady ? 'ok' : 'starting',
    uptime: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    timestamp: new Date().toISOString(),
  });
});

async function start() {
  const totalStart = Date.now();
  console.log('\n' + '━'.repeat(50));
  console.log('  PREDICTIVE TRANSIT — Starting up...');
  console.log('━'.repeat(50));

  // Step 1
  const t1 = Date.now();
  console.log('\n  [1/6] 📦 Initializing database...');
  await initDatabase();
  pool = require('./db/connection');
  console.log(`  [1/6] ✅ Database ready (${((Date.now() - t1) / 1000).toFixed(1)}s)`);

  // Step 2
  const t2 = Date.now();
  console.log('  [2/6] 📂 Loading hackathon CSV data...');
  await loadHackathonData(pool);
  await ensureSivasWeatherSeeded(pool);
  console.log(`  [2/6] ✅ Data loaded (${((Date.now() - t2) / 1000).toFixed(1)}s)`);

  // Step 3
  console.log('  [3/6] 🔧 Creating database indexes...');
  try {
    await pool.execute('CREATE INDEX IF NOT EXISTS idx_ha_stop_line ON hackathon_arrivals (stop_id, line_id, scheduled_arrival)');
  } catch (_) { /* index may already exist */ }
  console.log('  [3/6] ✅ Indexes ready');

  // Step 4
  console.log('  [4/6] 🗑️  Clearing model cache (force retrain)...');
  const fs = require('fs');
  const cachePath = require('path').join(__dirname, 'ml', 'cache');
  try {
    if (fs.existsSync(cachePath)) {
      const files = fs.readdirSync(cachePath);
      for (const f of files) fs.unlinkSync(require('path').join(cachePath, f));
    }
  } catch (e) { }
  console.log('  [4/6] ✅ Cache cleared');

  // Step 5 + 6 (ML training)
  console.log('  [5/6] 🧠 Training arrival model (~65s)...');
  console.log('  [6/6] 🧠 Training crowd model (~60s)...');
  console.log('');
  await predictor.init(pool);

  const totalSec = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log('\n' + '━'.repeat(50));
  console.log(`  ✅ ALL SYSTEMS READY — Total startup: ${totalSec}s`);
  console.log('━'.repeat(50));

  serverReady = true;
  app.listen(PORT, () => {
    console.log(`\n  🚌 Server:  http://localhost:${PORT}`);
    console.log(`  📊 Model:   http://localhost:${PORT}/api/model/info`);
    console.log(`  💡 Advice:  http://localhost:${PORT}/api/stops/STP-L01-04/advice`);
    console.log(`  ❤️  Health:  http://localhost:${PORT}/api/health\n`);
  });
}

start();

// ─── Global Error Handlers ──────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Promise Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  process.exit(1);
});
