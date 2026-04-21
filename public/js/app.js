// ─── App Controller ─────────────────────────────────────────────────────

(async function () {
  'use strict';

  // ── Feature flags ─────────────────────────────────────────────────
  // Temporary: restrict the app to Sivas only. Other cities in the DB
  // come with synthetic stops/routes and aren't demo-ready yet.
  // To re-enable: set ENABLED_CITIES = null (or add names to the list).
  const ENABLED_CITIES = ['Sivas'];

  let currentCity = null;
  let allStops = [];
  let allRoutes = [];
  let allCities = [];
  let refreshInterval = null;

  // Journey Planner state
  let selectedStopId = null;
  let journeyDestId = null;       // destination stop ID (null = arrivals mode)
  let journeyDestDebounce = null;

  // Leave-by Advisor state
  let leaveWalkMin = 3;            // active walk-time in minutes
  let lastAdviceData = null;       // cached so pill clicks re-render without re-fetching

  // ─── Initialize ─────────────────────────────────────────────────
  async function init() {
    // Start map immediately so Leaflet tiles begin downloading
    // while we wait for /api/cities (saves 200-500ms perceived load)
    MapController.init('map', onStopSelected, { lat: 39.7477, lng: 37.0179, zoom: 13 });

    // Load cities from DB, filtered by the ENABLED_CITIES flag above.
    const fetched = await DataService.getCities();
    allCities = ENABLED_CITIES
      ? fetched.filter(c => ENABLED_CITIES.includes(c.name))
      : fetched;
    if (allCities.length === 0) return;

    currentCity = allCities[0].name;

    // Feed cities to map
    MapController.setCities(allCities);

    // Build city toggle buttons — hidden when only one city is enabled.
    const cityToggleEl = document.getElementById('cityToggle');
    if (allCities.length > 1) {
      buildCityToggle(allCities);
    } else if (cityToggleEl) {
      cityToggleEl.style.display = 'none';
    }

    // Load data for default city + model info in parallel
    await Promise.all([
      switchCity(currentCity),
      UI.renderModelInfo(),
    ]);

    // Setup event listeners
    setupCityToggle();
    setupSearch();
    setupJourneySearch();
    setupLeaveAdvisor();
    setupThemeToggle();
    setupLiveBuses();
    setupPanelResizer();
  }

  /* ─── Panel resizer ────────────────────────────────────────────────
     Mobile (stacked): drag the handle vertically to resize the map height,
     writing --map-h on .app. Desktop (side-by-side): drag horizontally to
     resize the panel width via --panel-w. Persisted to localStorage per
     axis. Window-level move/up listeners so the drag survives the finger
     sliding off the 18px grip. */
  function setupPanelResizer() {
    const handle = document.getElementById('panelDragHandle');
    const root = document.getElementById('app');
    if (!handle || !root) return;

    const KEY_H = 'routeproject.mapH';
    const KEY_W = 'routeproject.panelW';
    const savedH = localStorage.getItem(KEY_H);
    const savedW = localStorage.getItem(KEY_W);
    if (savedH) root.style.setProperty('--map-h', savedH);
    if (savedW) root.style.setProperty('--panel-w', savedW);

    let dragging = false;
    let axis = 'y';
    let activePointerId = null;

    function isMobile() { return window.matchMedia('(max-width: 860px)').matches; }

    // ── Full-size toggle ─────────────────────────────────────────────
    const fullBtn = document.getElementById('panelFullsizeBtn');
    if (fullBtn) {
      fullBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        root.classList.toggle('is-panel-fullsize');
        if (window.MapController && window.MapController.invalidateSize) {
          setTimeout(() => window.MapController.invalidateSize(), 300);
        }
      });
      // Prevent drag-start when tapping the button.
      fullBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      fullBtn.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
      fullBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    }

    function applyMove(clientX, clientY) {
      if (!dragging) return;
      if (axis === 'y') {
        const header = document.querySelector('.header');
        const headerH = header ? header.getBoundingClientRect().bottom : 0;
        const minH = 120;
        const maxH = window.innerHeight - headerH - 140;
        const mapH = Math.max(minH, Math.min(maxH, clientY - headerH));
        root.style.setProperty('--map-h', mapH + 'px');
      } else {
        const minW = 280;
        const maxW = Math.max(minW + 40, window.innerWidth - 240);
        const panelW = Math.max(minW, Math.min(maxW, window.innerWidth - clientX));
        root.style.setProperty('--panel-w', panelW + 'px');
      }
      if (window.MapController && window.MapController.invalidateSize) {
        window.MapController.invalidateSize();
      }
    }

    function onPointerMove(e) { applyMove(e.clientX, e.clientY); }
    function onTouchMove(e) {
      if (!dragging || !e.touches || !e.touches[0]) return;
      applyMove(e.touches[0].clientX, e.touches[0].clientY);
      e.preventDefault();
    }

    function end() {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('is-dragging');
      document.body.classList.remove('is-resizing');
      if (activePointerId != null && handle.hasPointerCapture && handle.hasPointerCapture(activePointerId)) {
        try { handle.releasePointerCapture(activePointerId); } catch (_) {}
      }
      activePointerId = null;
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      handle.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', end);
      window.removeEventListener('touchcancel', end);
      window.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('mouseup', end);
      const cur = axis === 'y'
        ? getComputedStyle(root).getPropertyValue('--map-h').trim()
        : getComputedStyle(root).getPropertyValue('--panel-w').trim();
      if (cur) localStorage.setItem(axis === 'y' ? KEY_H : KEY_W, cur);
      if (window.MapController && window.MapController.invalidateSize) {
        window.MapController.invalidateSize();
      }
    }

    function start(clientX, clientY, e) {
      dragging = true;
      axis = isMobile() ? 'y' : 'x';
      handle.classList.add('is-dragging');
      document.body.classList.add('is-resizing');
      applyMove(clientX, clientY);
      if (e && e.cancelable) e.preventDefault();
    }

    // Pointer events — capture routes all move/up to the handle itself,
    // which is more reliable than window listeners in touch emulation.
    handle.addEventListener('pointerdown', (e) => {
      if (dragging) return;
      activePointerId = e.pointerId;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      start(e.clientX, e.clientY, e);
      handle.addEventListener('pointermove', onPointerMove);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
      // Safety net on window too — some WebKit builds drop pointerup on capture release.
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });

    // Touch fallback — listen on both handle AND window so neither a
    // DevTools quirk nor a finger sliding off the grip breaks the drag.
    handle.addEventListener('touchstart', (e) => {
      if (dragging) return;
      const t = e.touches[0];
      if (!t) return;
      start(t.clientX, t.clientY, e);
      handle.addEventListener('touchmove', onTouchMove, { passive: false });
      window.addEventListener('touchmove', onTouchMove, { passive: false });
      window.addEventListener('touchend', end);
      window.addEventListener('touchcancel', end);
    }, { passive: false });

    // Mouse fallback (very old browsers).
    handle.addEventListener('mousedown', (e) => {
      if (dragging) return;
      start(e.clientX, e.clientY, e);
      window.addEventListener('mousemove', onPointerMove);
      window.addEventListener('mouseup', end);
    });

    // Keep axis choice correct if the viewport crosses the breakpoint.
    window.addEventListener('resize', () => { if (!dragging) axis = isMobile() ? 'y' : 'x'; });
  }

  /* ─── Live bus polling ──────────────────────────────────────────────
     Fetches /api/live-buses every N seconds. The map's CSS transition
     on .live-bus-wrap animates each marker smoothly between ticks, so
     buses appear to move continuously even though the server pushes
     discrete snapshots. Slower poll = smoother slide but staler delay. */
  function setupLiveBuses() {
    const TICK_MS = 4000;
    async function tick() {
      try {
        const data = await DataService.getLiveBuses();
        if (data && Array.isArray(data.buses)) {
          MapController.renderLiveBuses(data.buses);
        }
      } catch (_) { /* swallow — next tick retries */ }
    }
    tick();
    setInterval(tick, TICK_MS);
  }

  /* ─── Theme Toggle ──────────────────────────────────────────────────
     Persists user choice in localStorage; falls back to
     prefers-color-scheme for first-time visitors. The <html data-theme>
     attribute is applied inline (before CSS paints) to avoid a flash;
     see the bootstrap snippet in index.html. */
  function setupThemeToggle() {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch (_) {}
      if (MapController && typeof MapController.setTheme === 'function') {
        MapController.setTheme(next);
      }
    });
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
    UI.clearCascade();
    MapController.clearCascade();
    UI.clearLeaveAdvisor();
    lastAdviceData = null;

    // Show journey search for Sivas stops
    const isSivas = currentCity && currentCity.toLowerCase() === 'sivas';
    const journeySearchEl = document.getElementById('journeySearch');
    if (journeySearchEl) {
      journeySearchEl.style.display = isSivas ? 'block' : 'none';
    }

    // Load arrivals in the default mode
    await loadArrivalsMode(stopId);

    // Cascade overlay (don't block arrivals UI on this — fire and forget)
    loadCascadeForStop(stop);

    // Start auto-refresh
    startAutoRefresh();
  }

  // ─── Delay Cascade ──────────────────────────────────────────────
  // Picks the first route serving this stop that has more than one
  // downstream stop and renders the cascade overlay + side-panel badge.
  // Guards against rapid-fire stop changes: discards results if the user
  // has already moved on to a different stop.
  async function loadCascadeForStop(stop) {
    if (!stop || !stop.routes || stop.routes.length === 0) return;

    for (const routeId of stop.routes) {
      const data = await DataService.getCascade(routeId, stop.id);
      if (selectedStopId !== stop.id) return;       // user moved on — abandon
      if (data && data.stops && data.stops.length >= 2) {
        UI.renderCascade(data);
        MapController.showCascade(data);
        return;
      }
    }
  }

  // ─── Arrivals Mode ──────────────────────────────────────────────
  async function loadArrivalsMode(stopId) {
    const isSivas = currentCity && currentCity.toLowerCase() === 'sivas';

    UI.setArrivalSectionMode('arrivals', null);

    if (isSivas) {
      try {
        const advice = await DataService.getAdvice(stopId);
        if (selectedStopId !== stopId) return;
        UI.renderAdvice(advice, stopId);
        if (advice.crowd) {
          UI.renderCrowd(advice.crowd);
        }
        lastAdviceData = advice;
        if (setupLeaveAdvisor.getMode && setupLeaveAdvisor.getMode() === 'plan') {
          setupLeaveAdvisor.triggerPlanFetch();
        } else {
          UI.renderLeaveAdvisor(advice, leaveWalkMin);
        }
      } catch (err) {
        // Fallback to regular endpoints
        const [arrivals, crowd] = await Promise.all([
          DataService.getArrivals(stopId),
          DataService.getCrowd(stopId),
        ]);
        if (selectedStopId !== stopId) return;
        UI.renderArrivals(arrivals);
        UI.renderCrowd(crowd);
        lastAdviceData = { options: arrivals };
        UI.renderLeaveAdvisor(lastAdviceData, leaveWalkMin);
      }
    } else {
      const [arrivals, crowd] = await Promise.all([
        DataService.getArrivals(stopId),
        DataService.getCrowd(stopId),
      ]);
      if (selectedStopId !== stopId) return;
      UI.renderArrivals(arrivals);
      UI.renderCrowd(crowd);
      lastAdviceData = { options: arrivals };
      UI.renderLeaveAdvisor(lastAdviceData, leaveWalkMin);
    }
  }

  // ─── Leave-by Advisor wiring ────────────────────────────────────
  // Two modes: "Leave now" (walk-minutes picker, re-renders from cached
  // advice) and "Plan a ride" (datetime picker → /api/stops/:id/at).
  let leaveMode = 'now';             // 'now' | 'plan'
  let planDebounceTimer = null;

  function setupLeaveAdvisor() {
    const pills = document.getElementById('leaveWalkPills');
    const custom = document.getElementById('leaveCustomMin');
    const tabs = document.getElementById('leaveModeTabs');
    const walkSec = document.getElementById('leaveWalkSection');
    const planSec = document.getElementById('leavePlanSection');
    const title = document.getElementById('leaveCardTitle');
    const planTime = document.getElementById('leavePlanTime');
    const planWin = document.getElementById('leavePlanWindow');
    const planWalk = document.getElementById('leavePlanWalk');
    if (!pills || !custom || !tabs) return;

    function applyWalkMin(min, source) {
      const clamped = Math.max(1, Math.min(60, Math.round(min)));
      leaveWalkMin = clamped;
      const presets = pills.querySelectorAll('.leave-pill');
      presets.forEach(p => {
        p.classList.toggle('active', Number(p.dataset.walk) === clamped);
      });
      if (source !== 'custom') custom.value = '';
      if (lastAdviceData) UI.renderLeaveAdvisor(lastAdviceData, clamped);
    }

    pills.addEventListener('click', (e) => {
      const btn = e.target.closest('.leave-pill');
      if (!btn) return;
      applyWalkMin(Number(btn.dataset.walk), 'pill');
    });
    custom.addEventListener('input', () => {
      const v = Number(custom.value);
      if (Number.isFinite(v) && v >= 1) applyWalkMin(v, 'custom');
    });

    // Default the datetime picker to "now + 15 min" in local time (the input
    // type is datetime-local so we build a naive local-time string).
    function defaultPlanTimeStr() {
      const d = new Date(Date.now() + 15 * 60 * 1000);
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    if (planTime && !planTime.value) planTime.value = defaultPlanTimeStr();

    function switchMode(mode) {
      leaveMode = mode;
      tabs.querySelectorAll('.leave-mode').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
      });
      if (mode === 'now') {
        walkSec.style.display = '';
        planSec.style.display = 'none';
        if (title) title.textContent = 'When should I leave?';
        if (lastAdviceData) UI.renderLeaveAdvisor(lastAdviceData, leaveWalkMin);
      } else {
        walkSec.style.display = 'none';
        planSec.style.display = '';
        if (title) title.textContent = 'Plan a ride';
        triggerPlanFetch();
      }
    }

    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.leave-mode');
      if (!btn) return;
      switchMode(btn.dataset.mode);
    });

    // Collapse/expand — keeps the planner out of the way so the crowd card
    // under it stays visible by default.
    const toggle = document.getElementById('leaveCollapseToggle');
    const card = document.getElementById('leaveAdvisorCard');
    if (toggle && card) {
      toggle.addEventListener('click', () => {
        const isCollapsed = card.classList.toggle('is-collapsed');
        toggle.setAttribute('aria-expanded', String(!isCollapsed));
      });
    }

    function triggerPlanFetch() {
      if (!selectedStopId) return;
      const isoLocal = planTime.value;
      if (!isoLocal) return;
      const targetDate = new Date(isoLocal);
      if (isNaN(targetDate.getTime())) return;
      const windowMin = Number(planWin.value) || 30;
      const walkOffset = Math.max(0, Math.min(60, Number(planWalk.value) || 0));
      UI.showPlanLoading();
      DataService.getStopAtTime(selectedStopId, targetDate, windowMin).then(data => {
        if (leaveMode !== 'plan') return;
        UI.renderPlanOptions(data, walkOffset);
      });
    }

    function debouncedPlanFetch() {
      clearTimeout(planDebounceTimer);
      planDebounceTimer = setTimeout(triggerPlanFetch, 250);
    }

    [planTime, planWin, planWalk].forEach(el => {
      if (el) el.addEventListener('change', debouncedPlanFetch);
      if (el) el.addEventListener('input', debouncedPlanFetch);
    });

    // Expose for re-fetch after stop selection
    setupLeaveAdvisor.triggerPlanFetch = triggerPlanFetch;
    setupLeaveAdvisor.getMode = () => leaveMode;
  }

  // ─── Journey Mode ──────────────────────────────────────────────
  async function loadJourneyMode(fromId, toId) {
    UI.showArrivalsLoading();
    UI.clearCascade();
    MapController.clearCascade();
    UI.clearLeaveAdvisor();

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
            <div class="journey-empty__title">Connection error</div>
            <div class="journey-empty__desc">Could not load journey plan. Please try again.</div>
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
            UI.renderAdvice(advice, selId);
            if (advice.crowd) UI.renderCrowd(advice.crowd);
            lastAdviceData = advice;
            UI.renderLeaveAdvisor(advice, leaveWalkMin);
          } catch (e) {}
        } else {
          const [arr, crd] = await Promise.all([
            DataService.getArrivals(selId),
            DataService.getCrowd(selId),
          ]);
          UI.renderArrivals(arr);
          UI.renderCrowd(crd);
          lastAdviceData = { options: arr };
          UI.renderLeaveAdvisor(lastAdviceData, leaveWalkMin);
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
        const stop = allStops.find(s => s.id === selectedStopId);
        if (stop) loadCascadeForStop(stop);
      }
    });
  }

  function renderJourneySearchResults(stops, container) {
    container.innerHTML = '';

    if (stops.length === 0) {
      container.innerHTML = `
        <div style="padding:12px;text-align:center;color:var(--text-muted);font-size:var(--fs-xs);">
          No stops found
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
