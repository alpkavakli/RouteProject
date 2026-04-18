// ─── App Controller ─────────────────────────────────────────────────────

(async function () {
  'use strict';

  let currentCity = null;
  let allStops = [];
  let allRoutes = [];
  let allCities = [];
  let refreshInterval = null;

  // Journey Planner state
  let selectedStopId = null;
  let journeyDestId = null;       // destination stop ID (null = arrivals mode)
  let journeyDestDebounce = null;

  // ─── Initialize ─────────────────────────────────────────────────
  async function init() {
    // Start map immediately so Leaflet tiles begin downloading
    // while we wait for /api/cities (saves 200-500ms perceived load)
    MapController.init('map', onStopSelected, { lat: 39.7477, lng: 37.0179, zoom: 13 });

    // Load cities from DB
    allCities = await DataService.getCities();
    if (allCities.length === 0) return;

    currentCity = allCities[0].name;

    // Feed cities to map
    MapController.setCities(allCities);

    // Build city toggle buttons
    buildCityToggle(allCities);

    // Load data for default city + model info in parallel
    await Promise.all([
      switchCity(currentCity),
      UI.renderModelInfo(),
    ]);

    // Setup event listeners
    setupCityToggle();
    setupSearch();
    setupJourneySearch();
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

    // Reset journey state
    selectedStopId = null;
    clearJourneyDestination();
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

    selectedStopId = stopId;

    // Reset journey destination when selecting a new stop
    clearJourneyDestination();

    UI.showPanelContent(stop, allRoutes);
    UI.showArrivalsLoading();
    UI.showCrowdLoading();

    // Show journey search for Sivas stops
    const isSivas = currentCity && currentCity.toLowerCase() === 'sivas';
    const journeySearchEl = document.getElementById('journeySearch');
    if (journeySearchEl) {
      journeySearchEl.style.display = isSivas ? 'block' : 'none';
    }

    // Load arrivals in the default mode
    await loadArrivalsMode(stopId);

    // Start auto-refresh
    startAutoRefresh();
  }

  // ─── Arrivals Mode ──────────────────────────────────────────────
  async function loadArrivalsMode(stopId) {
    const isSivas = currentCity && currentCity.toLowerCase() === 'sivas';

    UI.setArrivalSectionMode('arrivals', null);

    if (isSivas) {
      try {
        const advice = await DataService.getAdvice(stopId);
        UI.renderAdvice(advice);
        if (advice.crowd) {
          UI.renderCrowd(advice.crowd);
        }
      } catch (err) {
        // Fallback to regular endpoints
        const [arrivals, crowd] = await Promise.all([
          DataService.getArrivals(stopId),
          DataService.getCrowd(stopId),
        ]);
        UI.renderArrivals(arrivals);
        UI.renderCrowd(crowd);
      }
    } else {
      const [arrivals, crowd] = await Promise.all([
        DataService.getArrivals(stopId),
        DataService.getCrowd(stopId),
      ]);
      UI.renderArrivals(arrivals);
      UI.renderCrowd(crowd);
    }
  }

  // ─── Journey Mode ──────────────────────────────────────────────
  async function loadJourneyMode(fromId, toId) {
    UI.showArrivalsLoading();

    try {
      const journeyData = await DataService.getJourney(fromId, toId);
      if (journeyData) {
        UI.renderJourney(journeyData);
        MapController.highlightJourney(journeyData);
      } else {
        UI.setArrivalSectionMode('journey', 0);
        const container = document.getElementById('arrivalCards');
        container.innerHTML = `
          <div class="journey-empty animate-fade-in">
            <div class="journey-empty__icon">⚠️</div>
            <div class="journey-empty__title">Bağlantı hatası</div>
            <div class="journey-empty__desc">Yolculuk planı yüklenemedi. Tekrar deneyin.</div>
          </div>
        `;
      }
    } catch (err) {
      console.warn('[Journey] Load error:', err);
    }
  }

  // ─── Auto Refresh ───────────────────────────────────────────────
  function startAutoRefresh() {
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(async () => {
      const selId = MapController.getSelectedStopId();
      if (!selId) return;

      if (journeyDestId) {
        // Journey mode refresh
        await loadJourneyMode(selId, journeyDestId);
      } else {
        // Arrivals mode refresh
        const isSivas = currentCity && currentCity.toLowerCase() === 'sivas';
        if (isSivas) {
          try {
            const advice = await DataService.getAdvice(selId);
            UI.renderAdvice(advice);
            if (advice.crowd) UI.renderCrowd(advice.crowd);
          } catch (e) {}
        } else {
          const [arr, crd] = await Promise.all([
            DataService.getArrivals(selId),
            DataService.getCrowd(selId),
          ]);
          UI.renderArrivals(arr);
          UI.renderCrowd(crd);
        }
      }
    }, 30000);
  }

  // ─── Journey Destination Search ─────────────────────────────────
  function setupJourneySearch() {
    const input = document.getElementById('journeyDestInput');
    const results = document.getElementById('journeyDestResults');
    const clearBtn = document.getElementById('journeyClearBtn');

    if (!input || !results || !clearBtn) return;

    // Destination search input
    input.addEventListener('input', () => {
      clearTimeout(journeyDestDebounce);
      journeyDestDebounce = setTimeout(() => {
        const query = input.value.trim().toLowerCase();
        if (query.length < 1) {
          results.classList.remove('visible');
          return;
        }

        // Filter stops: exclude the currently selected stop, match by name or route
        const filtered = allStops.filter(s =>
          s.id !== selectedStopId &&
          (s.name.toLowerCase().includes(query) ||
           s.routes.some(r => r.toLowerCase().includes(query)))
        ).slice(0, 8); // limit results

        renderJourneySearchResults(filtered, results);
        results.classList.add('visible');
      }, 200);
    });

    // Close dropdown on click outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.journey-search')) {
        results.classList.remove('visible');
      }
    });

    // Escape closes dropdown
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        results.classList.remove('visible');
        input.blur();
      }
    });

    // Clear button
    clearBtn.addEventListener('click', () => {
      clearJourneyDestination();
      if (selectedStopId) {
        UI.showArrivalsLoading();
        loadArrivalsMode(selectedStopId);
      }
    });
  }

  function renderJourneySearchResults(stops, container) {
    container.innerHTML = '';

    if (stops.length === 0) {
      container.innerHTML = `
        <div style="padding:12px;text-align:center;color:var(--text-muted);font-size:var(--fs-xs);">
          Durak bulunamadı
        </div>`;
      return;
    }

    stops.forEach(stop => {
      const div = document.createElement('div');
      div.className = 'journey-search__result';
      div.innerHTML = `
        <span class="journey-search__result-icon">📍</span>
        <span>${stop.name}</span>
        <span class="journey-search__result-routes">${stop.routes.join(', ')}</span>
      `;
      div.addEventListener('click', () => {
        selectJourneyDestination(stop);
      });
      container.appendChild(div);
    });
  }

  function selectJourneyDestination(destStop) {
    journeyDestId = destStop.id;

    const input = document.getElementById('journeyDestInput');
    const results = document.getElementById('journeyDestResults');

    if (input) input.value = destStop.name;
    if (results) results.classList.remove('visible');

    // Switch to journey mode
    if (selectedStopId) {
      loadJourneyMode(selectedStopId, journeyDestId);
    }
  }

  function clearJourneyDestination() {
    journeyDestId = null;

    const input = document.getElementById('journeyDestInput');
    const results = document.getElementById('journeyDestResults');

    if (input) input.value = '';
    if (results) results.classList.remove('visible');

    // Clear map highlight and revert section title
    MapController.clearJourneyHighlight();
    UI.setArrivalSectionMode('arrivals', null);
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
