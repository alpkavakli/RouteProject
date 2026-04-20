const mysql = require('mysql2/promise');

async function connectWithRetry(config, attempts = 15, delayMs = 2000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await mysql.createConnection(config);
    } catch (err) {
      const transient = err.code === 'EAI_AGAIN' || err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED';
      if (!transient || i === attempts) throw err;
      console.log(`  ⏳ DB not reachable (${err.code}), retry ${i}/${attempts} in ${delayMs}ms...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function initDatabase() {
  const dbName = process.env.DB_NAME || 'predictive_transit';

  // Create database if it doesn't exist
  const conn = await connectWithRetry({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    port: parseInt(process.env.DB_PORT || '3306'),
  });
  await conn.execute(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
  await conn.end();

  // Now use the pool for table creation
  const pool = require('./connection');

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS cities (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      lat DOUBLE NOT NULL,
      lng DOUBLE NOT NULL,
      zoom INT DEFAULT 13
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS stops (
      id VARCHAR(30) PRIMARY KEY,
      city_id INT NOT NULL,
      name VARCHAR(200) NOT NULL,
      lat DOUBLE NOT NULL,
      lng DOUBLE NOT NULL,
      popularity DOUBLE DEFAULT 0.5,
      avg_delay DOUBLE DEFAULT 2.0,
      FOREIGN KEY (city_id) REFERENCES cities(id) ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS routes (
      id VARCHAR(30) PRIMARY KEY,
      city_id INT NOT NULL,
      name VARCHAR(200) NOT NULL,
      color VARCHAR(10) DEFAULT '#4f8cff',
      FOREIGN KEY (city_id) REFERENCES cities(id) ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS route_stops (
      route_id VARCHAR(30) NOT NULL,
      stop_id VARCHAR(30) NOT NULL,
      stop_order INT NOT NULL,
      PRIMARY KEY (route_id, stop_id),
      FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
      FOREIGN KEY (stop_id) REFERENCES stops(id) ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS weather (
      id INT AUTO_INCREMENT PRIMARY KEY,
      city_id INT NOT NULL,
      label VARCHAR(50) NOT NULL,
      icon VARCHAR(30) NOT NULL,
      temp INT NOT NULL,
      humidity INT NOT NULL,
      wind_speed INT NOT NULL,
      precipitation INT DEFAULT 0,
      feels_like INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (city_id) REFERENCES cities(id) ON DELETE CASCADE
    )
  `);

  // ─── Hackathon Data Tables ──────────────────────────────────────────
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS hackathon_trips (
      id INT AUTO_INCREMENT PRIMARY KEY,
      trip_id VARCHAR(30) NOT NULL,
      line_id VARCHAR(10) NOT NULL,
      line_name VARCHAR(100),
      direction VARCHAR(20),
      day_of_week INT,
      is_weekend TINYINT,
      time_of_day VARCHAR(20),
      planned_departure TIME,
      actual_departure TIME,
      departure_delay_min DOUBLE,
      planned_duration_min DOUBLE,
      actual_duration_min DOUBLE,
      weather_condition VARCHAR(30),
      temperature_c DOUBLE,
      precipitation_mm DOUBLE,
      wind_speed_kmh DOUBLE,
      traffic_level VARCHAR(20),
      speed_factor DOUBLE,
      num_stops INT,
      avg_occupancy_pct DOUBLE,
      bus_capacity INT DEFAULT 60,
      INDEX idx_ht_line (line_id),
      INDEX idx_ht_trip (trip_id)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS hackathon_arrivals (
      id INT AUTO_INCREMENT PRIMARY KEY,
      arrival_id VARCHAR(30) NOT NULL,
      trip_id VARCHAR(30) NOT NULL,
      line_id VARCHAR(10) NOT NULL,
      stop_id VARCHAR(30) NOT NULL,
      stop_sequence INT,
      scheduled_arrival TIME,
      actual_arrival TIME,
      delay_min DOUBLE,
      passengers_waiting INT,
      passengers_boarding INT,
      passengers_alighting INT,
      dwell_time_min DOUBLE,
      cumulative_delay_min DOUBLE,
      weather_condition VARCHAR(30),
      temperature_c DOUBLE,
      speed_factor DOUBLE,
      minutes_to_next_bus DOUBLE,
      INDEX idx_ha_stop (stop_id),
      INDEX idx_ha_trip (trip_id),
      INDEX idx_ha_line (line_id)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS hackathon_passenger_flow (
      id INT AUTO_INCREMENT PRIMARY KEY,
      stop_id VARCHAR(30) NOT NULL,
      line_id VARCHAR(10) NOT NULL,
      stop_type VARCHAR(30),
      hour_of_day INT,
      day_of_week INT,
      is_weekend TINYINT,
      time_bucket VARCHAR(30),
      weather_condition VARCHAR(30),
      avg_passengers_waiting DOUBLE,
      avg_passengers_boarding DOUBLE,
      avg_dwell_time_min DOUBLE,
      sample_count INT,
      std_passengers_waiting DOUBLE,
      max_passengers_waiting INT,
      crowding_level VARCHAR(20),
      INDEX idx_hpf_stop (stop_id),
      INDEX idx_hpf_line (line_id)
    )
  `);

  // Seed if empty
  const [rows] = await pool.execute('SELECT COUNT(*) as count FROM cities');
  if (rows[0].count === 0) {
    console.log('   Seeding database with initial data...');
    await seedData(pool);
    console.log('   Database seeded.');
  }

  // Ensure Sivas exists (may be missing on DBs seeded before Sivas was added)
  await pool.execute(
    'INSERT IGNORE INTO cities (name, lat, lng, zoom) VALUES (?, ?, ?, ?)',
    ['Sivas', 39.7477, 37.0179, 13]
  );
}

async function seedData(pool) {
  // Cities
  const cities = [
    ['Istanbul', 41.0082, 28.9784, 13],
    ['Ankara',   39.9334, 32.8597, 13],
    ['Izmir',    38.4237, 27.1428, 13],
    ['Bursa',    40.1885, 29.0610, 13],
    ['Antalya',  36.8969, 30.7133, 13],
    ['Sivas',    39.7477, 37.0179, 13],
  ];

  for (const [name, lat, lng, zoom] of cities) {
    await pool.execute('INSERT INTO cities (name, lat, lng, zoom) VALUES (?, ?, ?, ?)', [name, lat, lng, zoom]);
  }

  const cityIds = {};
  const [cityRows] = await pool.execute('SELECT id, name FROM cities');
  for (const row of cityRows) cityIds[row.name] = row.id;

  // Stops — real coordinates from OpenStreetMap (Overpass API)
  const stops = [
    // Istanbul (10 stops) — source: OSM / IETT network
    ['ist-1',  'Istanbul', 'Beşiktaş Meydan',              41.043561, 29.006820, 0.95, 3.0],
    ['ist-2',  'Istanbul', 'Dolmabahçe',                    41.039918, 28.992754, 0.85, 2.8],
    ['ist-3',  'Istanbul', 'Vezneciler',                    41.011499, 28.960742, 0.80, 2.5],
    ['ist-4',  'Istanbul', 'Akaretler',                     41.041706, 29.004142, 0.75, 2.2],
    ['ist-5',  'Istanbul', 'Etiler',                        41.080129, 29.033424, 0.70, 1.8],
    ['ist-6',  'Istanbul', 'Nispetiye',                     41.084936, 29.043044, 0.60, 1.5],
    ['ist-7',  'Istanbul', 'İstinye İskelesi',              41.113891, 29.059820, 0.65, 2.0],
    ['ist-8',  'Istanbul', 'Çarşı',                         41.078616, 29.030431, 0.72, 2.3],
    ['ist-9',  'Istanbul', 'Cengiz Topel',                  41.084591, 29.040429, 0.55, 1.4],
    ['ist-10', 'Istanbul', 'Basın Sitesi',                  41.082713, 29.038148, 0.50, 1.2],
    // Ankara (8 stops) — source: OSM / EGO network
    ['ank-1', 'Ankara', 'Kuğulu Park',                      39.902341, 32.860780, 0.90, 2.5],
    ['ank-2', 'Ankara', 'Atakule',                          39.884580, 32.855745, 0.80, 2.2],
    ['ank-3', 'Ankara', 'Çankaya Lisesi',                   39.884823, 32.853066, 0.65, 1.8],
    ['ank-4', 'Ankara', 'Botanik Parkı',                    39.887093, 32.854912, 0.60, 1.5],
    ['ank-5', 'Ankara', 'Arjantin Caddesi',                 39.897174, 32.866260, 0.70, 2.0],
    ['ank-6', 'Ankara', 'Nenehatun Caddesi',                39.898006, 32.868887, 0.55, 1.6],
    ['ank-7', 'Ankara', 'Köroğlu Camii',                    39.895899, 32.878871, 0.50, 1.3],
    ['ank-8', 'Ankara', 'Kız Kulesi Sokak',                 39.891255, 32.872202, 0.45, 1.2],
    // Izmir (8 stops) — source: OSM / ESHOT network
    ['izm-1', 'Izmir', 'Konak',                             38.416609, 27.127003, 0.92, 2.8],
    ['izm-2', 'Izmir', 'Alsancak Gar',                      38.438356, 27.147817, 0.85, 2.5],
    ['izm-3', 'Izmir', 'Belediye Sarayı',                   38.421439, 27.129762, 0.78, 2.0],
    ['izm-4', 'Izmir', 'Çankaya',                           38.423465, 27.137510, 0.70, 1.8],
    ['izm-5', 'Izmir', 'Lozan',                             38.431205, 27.142558, 0.65, 1.6],
    ['izm-6', 'Izmir', 'Talatpaşa',                         38.434381, 27.142458, 0.60, 1.5],
    ['izm-7', 'Izmir', 'Eşrefpaşa Hastanesi',               38.423443, 27.159883, 0.55, 1.4],
    ['izm-8', 'Izmir', 'Liman',                             38.440307, 27.149904, 0.72, 2.2],
    // Bursa (8 stops) — source: OSM
    ['brs-1', 'Bursa', 'Kent Meydanı',                      40.195971, 29.061245, 0.88, 2.5],
    ['brs-2', 'Bursa', 'Şehreküstü',                        40.188726, 29.062526, 0.75, 2.0],
    ['brs-3', 'Bursa', 'Altıparmak',                         40.190030, 29.052600, 0.72, 2.2],
    ['brs-4', 'Bursa', 'Süleyman Çelebi',                   40.201885, 29.027870, 0.60, 1.5],
    ['brs-5', 'Bursa', 'Fevzi Çakmak Caddesi',              40.189754, 29.060542, 0.65, 1.8],
    ['brs-6', 'Bursa', 'Altıparmak Şehabettin Paşa Cami',  40.188608, 29.057591, 0.50, 1.3],
    // Antalya (8 stops) — source: OSM
    ['ant-1', 'Antalya', 'Cumhuriyet Meydanı',              36.886717, 30.702368, 0.85, 2.3],
    ['ant-2', 'Antalya', 'Yener Ulusoy Bulvarı',            36.892143, 30.698750, 0.70, 1.8],
    ['ant-3', 'Antalya', 'Antalya Aquarium',                36.881292, 30.661672, 0.75, 1.5],
    ['ant-4', 'Antalya', 'Barınaklar Bulvarı',              36.855150, 30.779432, 0.60, 1.6],
    ['ant-5', 'Antalya', 'Lunapark',                        36.883773, 30.657925, 0.55, 1.4],
    ['ant-6', 'Antalya', 'Migros',                          36.883472, 30.658369, 0.50, 1.3],
    ['ant-7', 'Antalya', 'Meydan',                          36.886945, 30.731292, 0.65, 1.7],
    ['ant-8', 'Antalya', 'Antalya E-Ticaret',               36.854242, 30.776466, 0.48, 1.2],
  ];

  for (const [id, cityName, name, lat, lng, pop, delay] of stops) {
    await pool.execute(
      'INSERT INTO stops (id, city_id, name, lat, lng, popularity, avg_delay) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, cityIds[cityName], name, lat, lng, pop, delay]
    );
  }

  // Routes — connecting real OSM stops
  const routes = [
    // Istanbul (12 routes)
    ['40B',  'Istanbul', '40B Beşiktaş–Nispetiye',       '#ef4444', ['ist-1','ist-4','ist-8','ist-5','ist-6']],
    ['22',   'Istanbul', '22 Beşiktaş–Dolmabahçe',       '#3b82f6', ['ist-1','ist-2']],
    ['DT2',  'Istanbul', 'DT2 Beşiktaş–İstinye',         '#8b5cf6', ['ist-1','ist-5','ist-6','ist-7']],
    ['25G',  'Istanbul', '25G Dolmabahçe–Vezneciler',     '#f59e0b', ['ist-2','ist-3']],
    ['559C', 'Istanbul', '559C Akaretler–Çarşı–Etiler',   '#ec4899', ['ist-4','ist-8','ist-5']],
    ['29',   'Istanbul', '29 Etiler–Nispetiye',           '#10b981', ['ist-5','ist-9','ist-6']],
    ['40',   'Istanbul', '40 Çarşı–Basın Sitesi',        '#06b6d4', ['ist-8','ist-10','ist-9']],
    ['42T',  'Istanbul', '42T İstinye–Beşiktaş',         '#84cc16', ['ist-7','ist-6','ist-1']],
    ['62',   'Istanbul', '62 Vezneciler–Dolmabahçe',      '#f97316', ['ist-3','ist-2']],
    ['29D',  'Istanbul', '29D Cengiz Topel–Etiler',       '#14b8a6', ['ist-9','ist-5']],
    ['40T',  'Istanbul', '40T Basın Sitesi–Nispetiye',    '#a855f7', ['ist-10','ist-9','ist-6']],
    ['DT1',  'Istanbul', 'DT1 Akaretler–İstinye Express', '#d946ef', ['ist-4','ist-5','ist-6','ist-7']],
    // Ankara (8 routes)
    ['114',  'Ankara', '114 Kuğulu Park–Atakule',          '#ef4444', ['ank-1','ank-5','ank-2']],
    ['125',  'Ankara', '125 Kuğulu Park–Köroğlu',          '#3b82f6', ['ank-1','ank-5','ank-6','ank-7']],
    ['442',  'Ankara', '442 Çankaya–Botanik',              '#f59e0b', ['ank-3','ank-4','ank-2']],
    ['341',  'Ankara', '341 Atakule–Arjantin Cad.',        '#8b5cf6', ['ank-2','ank-4','ank-5']],
    ['197',  'Ankara', '197 Nenehatun–Kız Kulesi',         '#10b981', ['ank-6','ank-8']],
    ['EGO1', 'Ankara', 'EGO1 Kuğulu–Çankaya Ring',         '#ec4899', ['ank-1','ank-3','ank-4','ank-2']],
    ['EGO5', 'Ankara', 'EGO5 Arjantin–Köroğlu',            '#06b6d4', ['ank-5','ank-7']],
    ['510',  'Ankara', '510 Botanik–Nenehatun Express',     '#f97316', ['ank-4','ank-6','ank-8']],
    // Izmir (8 routes)
    ['35',   'Izmir', '35 Konak–Alsancak Gar',              '#ef4444', ['izm-1','izm-3','izm-4','izm-5','izm-6','izm-2']],
    ['90',   'Izmir', '90 Konak–Liman',                     '#3b82f6', ['izm-1','izm-3','izm-5','izm-8']],
    ['285',  'Izmir', '285 Belediye–Çankaya–Lozan',          '#f59e0b', ['izm-3','izm-4','izm-5']],
    ['168',  'Izmir', '168 Talatpaşa–Alsancak Gar',          '#8b5cf6', ['izm-6','izm-2']],
    ['77',   'Izmir', '77 Eşrefpaşa–Konak',                  '#10b981', ['izm-7','izm-1']],
    ['155',  'Izmir', '155 Liman–Lozan–Talatpaşa',            '#ec4899', ['izm-8','izm-5','izm-6']],
    ['340',  'Izmir', '340 Konak–Eşrefpaşa–Çankaya',          '#06b6d4', ['izm-1','izm-7','izm-4']],
    ['421',  'Izmir', '421 Alsancak–Liman Express',            '#d946ef', ['izm-2','izm-8']],
    // Bursa (6 routes)
    ['BT1',  'Bursa', 'BT1 Kent Meydanı–Süleyman Çelebi',   '#ef4444', ['brs-1','brs-5','brs-3','brs-4']],
    ['BT2',  'Bursa', 'BT2 Şehreküstü–Altıparmak',          '#3b82f6', ['brs-2','brs-5','brs-3']],
    ['B38',  'Bursa', 'B38 Altıparmak–Kent Meydanı',         '#f59e0b', ['brs-3','brs-1']],
    ['B55',  'Bursa', 'B55 Şehreküstü–Süleyman Çelebi',     '#8b5cf6', ['brs-2','brs-6','brs-4']],
    ['BK1',  'Bursa', 'BK1 Kent Meydanı Ring',              '#10b981', ['brs-1','brs-2','brs-5','brs-3']],
    ['BK2',  'Bursa', 'BK2 Fevzi Çakmak–Şehreküstü',        '#ec4899', ['brs-5','brs-2']],
    // Antalya (7 routes)
    ['KC10', 'Antalya', 'KC10 Cumhuriyet–Yener Ulusoy',      '#ef4444', ['ant-1','ant-2']],
    ['VK06', 'Antalya', 'VK06 Cumhuriyet–Aquarium',          '#3b82f6', ['ant-1','ant-3','ant-5']],
    ['KL08', 'Antalya', 'KL08 Cumhuriyet–Barınaklar',        '#f59e0b', ['ant-1','ant-7','ant-4']],
    ['MC44', 'Antalya', 'MC44 Meydan–E-Ticaret',             '#8b5cf6', ['ant-7','ant-8','ant-4']],
    ['KL55', 'Antalya', 'KL55 Lunapark–Migros–Aquarium',     '#10b981', ['ant-5','ant-6','ant-3']],
    ['UC22', 'Antalya', 'UC22 Yener Ulusoy–Meydan',          '#ec4899', ['ant-2','ant-1','ant-7']],
    ['VK80', 'Antalya', 'VK80 Barınaklar–Cumhuriyet Exp.',   '#06b6d4', ['ant-4','ant-8','ant-7','ant-1']],
  ];

  for (const [id, cityName, name, color, stopIds] of routes) {
    await pool.execute(
      'INSERT INTO routes (id, city_id, name, color) VALUES (?, ?, ?, ?)',
      [id, cityIds[cityName], name, color]
    );
    for (let i = 0; i < stopIds.length; i++) {
      await pool.execute(
        'INSERT INTO route_stops (route_id, stop_id, stop_order) VALUES (?, ?, ?)',
        [id, stopIds[i], i]
      );
    }
  }
}

module.exports = { initDatabase };
