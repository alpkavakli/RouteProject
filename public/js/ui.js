// ─── UI Renderer ────────────────────────────────────────────────────────

const UI = (() => {

  // ─── Weather ──────────────────────────────────────────────────────
  const weatherIcons = {
    sunny: '☀️',
    partly_cloudy: '⛅',
    rainy: '🌧️',
    cloudy: '☁️',
    windy: '💨',
  };

  function renderWeather(weather) {
    const icon = document.getElementById('weatherIcon');
    const temp = document.getElementById('weatherTemp');
    const wind = document.getElementById('weatherWind');
    const humidity = document.getElementById('weatherHumidity');

    icon.textContent = weatherIcons[weather.icon] || '🌡️';
    temp.textContent = `${weather.temp}°C`;
    wind.textContent = `💨 ${weather.windSpeed} km/h`;
    humidity.textContent = `💧 ${weather.humidity}%`;
  }

  // ─── Search ───────────────────────────────────────────────────────
  function renderSearchResults(stops, container, onSelect) {
    container.innerHTML = '';
    if (stops.length === 0) {
      container.innerHTML = `
        <div style="padding:16px;text-align:center;color:var(--text-muted);font-size:var(--fs-sm);">
          No stops found
        </div>`;
      return;
    }

    stops.forEach(stop => {
      const div = document.createElement('div');
      div.className = 'search-result animate-fade-in';
      div.innerHTML = `
        <span class="search-result__icon">🚏</span>
        <div class="search-result__info">
          <div class="search-result__name">${stop.name}</div>
          <div class="search-result__city">${stop.city} · ${stop.routes.length} routes</div>
        </div>
      `;
      div.addEventListener('click', () => onSelect(stop));
      container.appendChild(div);
    });
  }

  // ─── Panel ────────────────────────────────────────────────────────
  function showPanelEmpty() {
    document.getElementById('panelEmpty').style.display = 'flex';
    document.getElementById('panelContent').style.display = 'none';
  }

  function showPanelContent(stop, routes) {
    document.getElementById('panelEmpty').style.display = 'none';
    const content = document.getElementById('panelContent');
    content.style.display = 'flex';

    document.getElementById('panelStopName').textContent = stop.name;
    document.getElementById('panelStopCity').textContent = stop.city;

    // Route badges
    const routesContainer = document.getElementById('panelRoutes');
    routesContainer.innerHTML = stop.routes.map(rid => {
      const route = routes.find(r => r.id === rid);
      const color = route ? route.color : '#4f8cff';
      return `<span class="route-badge" style="background:${color}">${rid}</span>`;
    }).join('');
  }

  // ─── Crowd Card ───────────────────────────────────────────────────
  function renderCrowd(crowd) {
    const container = document.getElementById('crowdCard');
    const level = crowd.level;

    const dotClass = (i, lvl) => {
      if (lvl === 'low' && i === 0) return `active-low`;
      if (lvl === 'medium' && i <= 1) return `active-medium`;
      if (lvl === 'high') return `active-high`;
      return '';
    };

    const trendIcon = { rising: '📈', stable: '➡️', falling: '📉' };
    const trendLabel = { rising: 'Rising', stable: 'Stable', falling: 'Falling' };

    const mlTag = crowd.mlPowered
      ? `<span class="ml-badge">🧠 ML Predicted</span>`
      : '';

    // Probability bars
    const probSection = crowd.probabilities ? `
      <div style="display:flex;gap:6px;margin-top:8px;align-items:center;">
        <span style="font-size:10px;color:var(--text-muted);width:50px;">Prob:</span>
        <div style="flex:1;display:flex;gap:3px;align-items:center;">
          <span style="font-size:10px;color:var(--crowd-low);">L ${crowd.probabilities.low}%</span>
          <span style="font-size:10px;color:var(--crowd-medium);margin-left:auto;">M ${crowd.probabilities.medium}%</span>
          <span style="font-size:10px;color:var(--crowd-high);margin-left:auto;">H ${crowd.probabilities.high}%</span>
        </div>
      </div>
    ` : '';

    container.innerHTML = `
      <div class="crowd-card animate-slide-up">
        <div class="crowd-card__top">
          <div class="crowd-card__level">
            <div class="crowd-card__indicator">
              ${[0, 1, 2].map(i => `<div class="crowd-dot ${dotClass(i, level)}"></div>`).join('')}
            </div>
            <span class="crowd-card__label ${level}">${level.charAt(0).toUpperCase() + level.slice(1)}</span>
            ${mlTag}
          </div>
          <div class="crowd-card__count">~<span>${crowd.estimatedCount}</span> people</div>
        </div>
        <div class="crowd-card__meta">
          <div class="crowd-card__trend">
            ${trendIcon[crowd.trend] || ''} ${trendLabel[crowd.trend] || crowd.trend}
          </div>
          <span>Confidence: ${crowd.confidence || '--'}%</span>
        </div>
        ${probSection}
        <div class="crowd-card__reason">
          💡 ${crowd.reason}
        </div>
      </div>
    `;

    document.getElementById('crowdUpdatedAgo').textContent = `AI predicted`;
  }

  // ─── Arrival Cards ────────────────────────────────────────────────
  let countdownIntervals = [];

  function clearCountdowns() {
    countdownIntervals.forEach(id => clearInterval(id));
    countdownIntervals = [];
  }

  function renderArrivals(arrivals) {
    clearCountdowns();
    const container = document.getElementById('arrivalCards');
    container.innerHTML = '';

    document.getElementById('arrivalCount').textContent = `${arrivals.length} buses`;

    // Find recommended: first on-time/early with lowest predicted time and low crowd
    const recommended = arrivals.find(a => a.status !== 'delayed' && a.occupancy !== 'high') || arrivals[0];

    arrivals.forEach((arrival, idx) => {
      const isRecommended = arrival === recommended;
      const card = document.createElement('div');
      card.className = `arrival-card animate-slide-up ${isRecommended ? 'recommended' : ''}`;
      card.style.animationDelay = `${idx * 60}ms`;

      const statusLabel = {
        'on-time': '✅ On Time',
        'delayed': '⚠️ Delayed',
        'early': '⚡ Early',
      };

      const occupancyIcon = {
        'low': '🟢',
        'medium': '🟡',
        'high': '🔴',
      };

      // AI factors section
      const factors = arrival.factors || [];
      const factorsHTML = factors.length > 0 ? `
        <div class="arrival-card__factors">
          ${factors.map(f =>
            `<span class="factor-chip ${f.type}">${f.icon} ${f.label} ${f.impact}</span>`
          ).join('')}
        </div>
      ` : '';

      // Confidence bar
      const confColor = arrival.confidence >= 85 ? 'var(--accent-green)'
                       : arrival.confidence >= 70 ? 'var(--accent-amber)'
                       : 'var(--accent-red)';
      const confidenceBarHTML = `
        <div class="confidence-bar">
          <div class="confidence-bar__track">
            <div class="confidence-bar__fill" style="width:${arrival.confidence}%;background:${confColor};"></div>
          </div>
          <span class="confidence-bar__label">${arrival.confidence}%</span>
        </div>
      `;

      const mlBadge = arrival.mlPowered
        ? `<span class="ml-badge">🧠 ML</span>`
        : '';

      // Store the predicted time as a target
      const arrivalTime = Date.now() + arrival.predictedMin * 60 * 1000;

      card.innerHTML = `
        <div class="arrival-card__recommend-tag">⭐ Best Option</div>
        <div class="arrival-card__top">
          <div class="arrival-card__route-info">
            <span class="arrival-card__route-num" style="background:${arrival.routeColor}">${arrival.routeId}</span>
            <div>
              <div class="arrival-card__dest">→ ${arrival.destination} ${mlBadge}</div>
              <div class="arrival-card__vehicle">${arrival.vehicleId}</div>
            </div>
          </div>
          <div class="arrival-card__time">
            <div class="arrival-card__countdown" id="cd-${idx}" style="color:${arrival.routeColor}">
              ${arrival.predictedMin}<span class="arrival-card__countdown-unit"> min</span>
            </div>
          </div>
        </div>
        <div class="arrival-card__bottom">
          <span class="arrival-card__status ${arrival.status}">${statusLabel[arrival.status]}</span>
          <span class="arrival-card__occupancy ${arrival.occupancy}">${occupancyIcon[arrival.occupancy]} ${arrival.occupancy}</span>
          <span class="arrival-card__scheduled">Sched: ${arrival.scheduledMin}m</span>
        </div>
        ${confidenceBarHTML}
        ${factorsHTML}
      `;

      // Left border color
      card.style.borderLeftColor = arrival.routeColor;
      card.style.borderLeftWidth = '3px';
      card.style.borderLeftStyle = 'solid';

      container.appendChild(card);

      // Live countdown
      const cdEl = document.getElementById(`cd-${idx}`);
      if (cdEl) {
        const interval = setInterval(() => {
          const remaining = Math.max(0, Math.round((arrivalTime - Date.now()) / 60000));
          if (remaining <= 0) {
            cdEl.innerHTML = `<span style="color:var(--accent-green)">Arriving!</span>`;
            clearInterval(interval);
          } else if (remaining <= 1) {
            cdEl.innerHTML = `<span style="color:var(--accent-amber)">~1<span class="arrival-card__countdown-unit"> min</span></span>`;
            cdEl.style.animation = 'countdownPulse 1s ease infinite';
          } else {
            cdEl.innerHTML = `${remaining}<span class="arrival-card__countdown-unit"> min</span>`;
          }
        }, 15000);
        countdownIntervals.push(interval);
      }
    });
  }

  // ─── Model Info Footer ────────────────────────────────────────────
  async function renderModelInfo() {
    const footer = document.getElementById('modelInfo');
    if (!footer) return;

    try {
      const res = await fetch('/api/model/info');
      const info = await res.json();

      if (info && info.initialized) {
        const arrMAE = info.arrivalModel?.mae ?? '--';
        const crowdAcc = info.crowdModel?.accuracy ?? '--';
        footer.innerHTML = `
          <div class="model-info__badge">
            🧠 Random Forest ML · Trained on ${info.arrivalModel?.trainSamples || 0} samples
          </div>
          <div>
            Arrival MAE: <span class="model-info__stat">${arrMAE} min</span> ·
            Crowd Acc: <span class="model-info__stat">${crowdAcc}%</span>
          </div>
        `;
      }
    } catch (e) {
      // silent fail
    }
  }

  // ─── Loading States ───────────────────────────────────────────────
  function showArrivalsLoading() {
    const container = document.getElementById('arrivalCards');
    container.innerHTML = Array.from({ length: 3 }, () =>
      `<div class="skeleton skeleton-card"></div>`
    ).join('');
  }

  function showCrowdLoading() {
    const container = document.getElementById('crowdCard');
    container.innerHTML = `
      <div class="skeleton" style="height:100px;border-radius:var(--radius-lg);"></div>
    `;
  }

  return {
    renderWeather,
    renderSearchResults,
    showPanelEmpty,
    showPanelContent,
    renderCrowd,
    renderArrivals,
    renderModelInfo,
    showArrivalsLoading,
    showCrowdLoading,
    clearCountdowns,
  };
})();
