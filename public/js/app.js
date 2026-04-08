// ─── App Controller ─────────────────────────────────────────────────────

(async function () {
  'use strict';

  let currentCity = null;
  let allStops = [];
  let allRoutes = [];
  let allCities = [];
  let refreshInterval = null;

  // ─── Initialize ─────────────────────────────────────────────────
  async function init() {
    // Load cities from DB
    allCities = await DataService.getCities();
    if (allCities.length === 0) return;

    currentCity = allCities[0].name;

    // Feed cities to map and init
    MapController.setCities(allCities);
    MapController.init('map', onStopSelected, allCities[0]);

    // Build city toggle buttons
    buildCityToggle(allCities);

    // Load data for default city
    await switchCity(currentCity);

    // Setup event listeners
    setupCityToggle();
    setupSearch();

    // Fetch and render model info
    UI.renderModelInfo();
  }

  function buildCityToggle(cities) {
    const toggle = document.getElementById('cityToggle');
    toggle.innerHTML = '';
    cities.forEach((city, idx) => {
      const btn = document.createElement('button');
      btn.className = 'city-toggle__btn' + (idx === 0 ? ' active' : '');
      btn.dataset.city = city.name;
      btn.textContent = city.name;
      toggle.appendChild(btn);
    });
  }

  // ─── City Switching ─────────────────────────────────────────────
  async function switchCity(cityName) {
    currentCity = cityName;

    // Load stops and routes
    const [stops, routes, weather] = await Promise.all([
      DataService.getStops(cityName),
      DataService.getRoutes(cityName),
      DataService.getWeather(cityName),
    ]);

    allStops = stops;
    allRoutes = routes;

    // Render
    MapController.renderStops(stops);
    MapController.drawRoutes(routes, stops);
    MapController.flyToCity(cityName);
    UI.renderWeather(weather);
    UI.showPanelEmpty();

    // Clear any previous selection
    if (refreshInterval) clearInterval(refreshInterval);
    UI.clearCountdowns();
  }

  function setupCityToggle() {
    const toggle = document.getElementById('cityToggle');
    toggle.addEventListener('click', (e) => {
      const btn = e.target.closest('.city-toggle__btn');
      if (!btn || btn.classList.contains('active')) return;

      toggle.querySelectorAll('.city-toggle__btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      switchCity(btn.dataset.city);
    });
  }

  // ─── Stop Selection ─────────────────────────────────────────────
  async function onStopSelected(stopId) {
    const stop = allStops.find(s => s.id === stopId);
    if (!stop) return;

    UI.showPanelContent(stop, allRoutes);
    UI.showArrivalsLoading();
    UI.showCrowdLoading();

    // Fetch data
    const [arrivals, crowd] = await Promise.all([
      DataService.getArrivals(stopId),
      DataService.getCrowd(stopId),
    ]);

    UI.renderArrivals(arrivals);
    UI.renderCrowd(crowd);

    // Auto-refresh every 30s
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(async () => {
      const selId = MapController.getSelectedStopId();
      if (selId) {
        const [arr, crd] = await Promise.all([
          DataService.getArrivals(selId),
          DataService.getCrowd(selId),
        ]);
        UI.renderArrivals(arr);
        UI.renderCrowd(crd);
      }
    }, 30000);
  }

  // ─── Search ─────────────────────────────────────────────────────
  function setupSearch() {
    const input = document.getElementById('searchInput');
    const results = document.getElementById('searchResults');

    let debounceTimer;

    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const query = input.value.trim().toLowerCase();
        if (query.length < 1) {
          results.classList.remove('visible');
          return;
        }

        const filtered = allStops.filter(s =>
          s.name.toLowerCase().includes(query) ||
          s.routes.some(r => r.toLowerCase().includes(query))
        );

        UI.renderSearchResults(filtered, results, (stop) => {
          results.classList.remove('visible');
          input.value = stop.name;
          MapController.selectStop(stop.id);
        });

        results.classList.add('visible');
      }, 200);
    });

    // Close on click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.map-search')) {
        results.classList.remove('visible');
      }
    });

    // Close on escape
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        results.classList.remove('visible');
        input.blur();
      }
    });
  }

  // ─── Boot ───────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
