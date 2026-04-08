const express = require('express');
const cors = require('cors');
const path = require('path');
const predictor = require('./ml/predictor');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Data ───────────────────────────────────────────────────────────────────

const stops = [
  // Istanbul stops
  { id: 'ist-1', city: 'Istanbul', name: 'Taksim Meydanı', lat: 41.0370, lng: 28.9850, routes: ['T1','12','66T'] },
  { id: 'ist-2', city: 'Istanbul', name: 'Beşiktaş İskele', lat: 41.0432, lng: 29.0054, routes: ['DT1','22','559C'] },
  { id: 'ist-3', city: 'Istanbul', name: 'Eminönü', lat: 41.0176, lng: 28.9714, routes: ['T1','99','47'] },
  { id: 'ist-4', city: 'Istanbul', name: 'Kadıköy İskele', lat: 40.9906, lng: 29.0237, routes: ['14','17L','KM12'] },
  { id: 'ist-5', city: 'Istanbul', name: 'Üsküdar Meydanı', lat: 41.0253, lng: 29.0155, routes: ['15F','12','KM12'] },
  { id: 'ist-6', city: 'Istanbul', name: 'Levent Metro', lat: 41.0793, lng: 29.0113, routes: ['DT1','59R','29C'] },
  { id: 'ist-7', city: 'Istanbul', name: 'Sultanahmet', lat: 41.0054, lng: 28.9768, routes: ['T1','BN1','47'] },
  { id: 'ist-8', city: 'Istanbul', name: 'Mecidiyeköy', lat: 41.0676, lng: 28.9933, routes: ['DT1','66T','59R'] },
  // Ankara stops
  { id: 'ank-1', city: 'Ankara', name: 'Kızılay Meydanı', lat: 39.9208, lng: 32.8541, routes: ['M1','124','401'] },
  { id: 'ank-2', city: 'Ankara', name: 'Ulus Meydanı', lat: 39.9414, lng: 32.8563, routes: ['M1','354','112'] },
  { id: 'ank-3', city: 'Ankara', name: 'Çankaya', lat: 39.9032, lng: 32.8600, routes: ['124','442','EGO3'] },
  { id: 'ank-4', city: 'Ankara', name: 'Dikmen Vadisi', lat: 39.8920, lng: 32.8430, routes: ['401','442','124'] },
  { id: 'ank-5', city: 'Ankara', name: 'AŞTİ Terminal', lat: 39.9110, lng: 32.8100, routes: ['M1','354','EGO3'] },
  { id: 'ank-6', city: 'Ankara', name: 'Batıkent Metro', lat: 39.9700, lng: 32.7310, routes: ['M1','112','689'] },
  { id: 'ank-7', city: 'Ankara', name: 'Tunalı Hilmi Cad.', lat: 39.9130, lng: 32.8620, routes: ['124','401','442'] },
];

const routes = [
  // Istanbul routes
  { id: 'T1',   city: 'Istanbul', name: 'T1 Kabataş–Bağcılar',      color: '#ef4444', stops: ['ist-7','ist-3','ist-1'] },
  { id: '12',   city: 'Istanbul', name: '12 Taksim–Üsküdar',         color: '#3b82f6', stops: ['ist-1','ist-5'] },
  { id: '66T',  city: 'Istanbul', name: '66T Taksim–Mecidiyeköy',    color: '#f59e0b', stops: ['ist-1','ist-8'] },
  { id: 'DT1',  city: 'Istanbul', name: 'DT1 Beşiktaş–Levent',      color: '#8b5cf6', stops: ['ist-2','ist-8','ist-6'] },
  { id: '22',   city: 'Istanbul', name: '22 Beşiktaş–Kabataş',       color: '#10b981', stops: ['ist-2'] },
  { id: '559C', city: 'Istanbul', name: '559C Beşiktaş–Sarıyer',     color: '#ec4899', stops: ['ist-2'] },
  { id: '99',   city: 'Istanbul', name: '99 Eminönü Ring',            color: '#06b6d4', stops: ['ist-3'] },
  { id: '47',   city: 'Istanbul', name: '47 Eminönü–Sultanahmet',     color: '#84cc16', stops: ['ist-3','ist-7'] },
  { id: '14',   city: 'Istanbul', name: '14 Kadıköy–Bostancı',       color: '#f97316', stops: ['ist-4'] },
  { id: '17L',  city: 'Istanbul', name: '17L Kadıköy–Tuzla',         color: '#64748b', stops: ['ist-4'] },
  { id: 'KM12', city: 'Istanbul', name: 'KM12 Kadıköy–Üsküdar',     color: '#a855f7', stops: ['ist-4','ist-5'] },
  { id: '15F',  city: 'Istanbul', name: '15F Üsküdar–Beykoz',        color: '#14b8a6', stops: ['ist-5'] },
  { id: '59R',  city: 'Istanbul', name: '59R Mecidiyeköy–Levent',    color: '#e11d48', stops: ['ist-8','ist-6'] },
  { id: '29C',  city: 'Istanbul', name: '29C Levent–Hacıosman',      color: '#78716c', stops: ['ist-6'] },
  { id: 'BN1',  city: 'Istanbul', name: 'BN1 Sultanahmet–Eyüp',      color: '#d946ef', stops: ['ist-7'] },
  // Ankara routes
  { id: 'M1',   city: 'Ankara', name: 'M1 Kızılay–Batıkent',         color: '#ef4444', stops: ['ank-1','ank-2','ank-5','ank-6'] },
  { id: '124',  city: 'Ankara', name: '124 Kızılay–Çankaya–Tunalı',   color: '#3b82f6', stops: ['ank-1','ank-3','ank-7','ank-4'] },
  { id: '401',  city: 'Ankara', name: '401 Kızılay–Dikmen',           color: '#f59e0b', stops: ['ank-1','ank-4','ank-7'] },
  { id: '354',  city: 'Ankara', name: '354 Ulus–AŞTİ',                color: '#8b5cf6', stops: ['ank-2','ank-5'] },
  { id: '112',  city: 'Ankara', name: '112 Ulus–Batıkent',            color: '#10b981', stops: ['ank-2','ank-6'] },
  { id: '442',  city: 'Ankara', name: '442 Çankaya–Dikmen–Tunalı',    color: '#ec4899', stops: ['ank-3','ank-4','ank-7'] },
  { id: 'EGO3', city: 'Ankara', name: 'EGO3 Çankaya–AŞTİ',           color: '#06b6d4', stops: ['ank-3','ank-5'] },
  { id: '689',  city: 'Ankara', name: '689 Batıkent Express',         color: '#f97316', stops: ['ank-6'] },
];

// Current weather state (updated by weather endpoint, consumed by ML)
let currentWeatherCache = {};

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateWeather(city) {
  const conditions = [
    { label: 'Clear', icon: 'sunny', temp: randomBetween(18, 30) },
    { label: 'Partly Cloudy', icon: 'partly_cloudy', temp: randomBetween(14, 24) },
    { label: 'Rainy', icon: 'rainy', temp: randomBetween(8, 18) },
    { label: 'Overcast', icon: 'cloudy', temp: randomBetween(10, 20) },
    { label: 'Windy', icon: 'windy', temp: randomBetween(12, 22) },
  ];
  const cond = conditions[randomBetween(0, conditions.length - 1)];
  const weather = {
    city,
    ...cond,
    humidity: randomBetween(40, 85),
    windSpeed: randomBetween(5, 35),
    precipitation: cond.label === 'Rainy' ? randomBetween(20, 80) : randomBetween(0, 10),
    feelsLike: cond.temp + randomBetween(-3, 2),
  };

  // Feed weather to ML predictor
  currentWeatherCache[city] = weather;
  predictor.setWeather(weather);

  return weather;
}

// ─── API Routes ─────────────────────────────────────────────────────────────

app.get('/api/stops', (req, res) => {
  const { city } = req.query;
  let result = stops;
  if (city) result = stops.filter(s => s.city.toLowerCase() === city.toLowerCase());
  res.json(result);
});

app.get('/api/stops/:id', (req, res) => {
  const stop = stops.find(s => s.id === req.params.id);
  if (!stop) return res.status(404).json({ error: 'Stop not found' });
  res.json(stop);
});

app.get('/api/stops/:id/arrivals', (req, res) => {
  const stop = stops.find(s => s.id === req.params.id);
  if (!stop) return res.status(404).json({ error: 'Stop not found' });

  // If weather hasn't been fetched yet, generate it
  if (!currentWeatherCache[stop.city]) {
    generateWeather(stop.city);
  }

  // Use ML predictor
  const arrivals = predictor.predictArrivals(stop, routes);
  res.json(arrivals);
});

app.get('/api/stops/:id/crowd', (req, res) => {
  const stop = stops.find(s => s.id === req.params.id);
  if (!stop) return res.status(404).json({ error: 'Stop not found' });

  if (!currentWeatherCache[stop.city]) {
    generateWeather(stop.city);
  }

  // Get current arrivals for delay context
  const arrivals = predictor.predictArrivals(stop, routes);
  const crowd = predictor.predictCrowd(req.params.id, arrivals);
  res.json(crowd);
});

app.get('/api/routes', (req, res) => {
  const { city } = req.query;
  let result = routes;
  if (city) result = routes.filter(r => r.city.toLowerCase() === city.toLowerCase());
  res.json(result);
});

app.get('/api/weather', (req, res) => {
  const city = req.query.city || 'Istanbul';
  res.json(generateWeather(city));
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

async function start() {
  // Train ML models before accepting requests
  await predictor.init();

  app.listen(PORT, () => {
    console.log(`🚌 PREDICTIVE TRANSIT server running on http://localhost:${PORT}`);
    console.log(`📊 Model info: http://localhost:${PORT}/api/model/info`);
  });
}

start();
