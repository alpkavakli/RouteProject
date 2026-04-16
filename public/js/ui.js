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
    wind.textContent = `${weather.windSpeed} km/h`;
    humidity.textContent = `${weather.humidity}%`;
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
        <span class="search-result__icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="display:block">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
          </svg>
        </span>
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

  // ─── Crowd Card (5-class) ─────────────────────────────────────────
  function renderCrowd(crowd) {
    const container = document.getElementById('crowdCard');
    const level = crowd.level;

    // 5-class mapping
    const crowdConfig = {
      empty:    { color: '#22c55e', dotCount: 0 },
      light:    { color: '#84cc16', dotCount: 1 },
      low:      { color: '#22c55e', dotCount: 0 },
      moderate: { color: '#f59e0b', dotCount: 2 },
      medium:   { color: '#f59e0b', dotCount: 2 },
      busy:     { color: '#ef4444', dotCount: 3 },
      high:     { color: '#ef4444', dotCount: 3 },
      crowded:  { color: '#991b1b', dotCount: 4 },
    };

    const config = crowdConfig[level] || crowdConfig.moderate;
    const totalDots = 5;

    const trendIcon = { rising: '↑', stable: '→', falling: '↓' };
    const trendLabel = { rising: 'Rising', stable: 'Stable', falling: 'Falling' };

    const mlTag = crowd.mlPowered
      ? `<span class="ml-badge">ML Predicted</span>`
      : '';

    // Probability bars for all available classes
    const probKeys = crowd.probabilities ? Object.keys(crowd.probabilities) : [];
    const probSection = probKeys.length > 0 ? `
      <div style="display:flex;gap:4px;margin-top:8px;flex-wrap:wrap;">
        ${probKeys.map(k => {
          const pct = crowd.probabilities[k];
          const c = (crowdConfig[k] || {}).color || '#999';
          return `<span style="font-size:10px;color:${c};background:${c}15;padding:2px 6px;border-radius:6px;">${k} ${pct}%</span>`;
        }).join('')}
      </div>
    ` : '';

    container.innerHTML = `
      <div class="crowd-card animate-slide-up">
        <div class="crowd-card__top">
          <div class="crowd-card__level">
            <div class="crowd-card__indicator">
              ${Array.from({ length: totalDots }, (_, i) =>
                `<div class="crowd-dot" style="background:${i <= config.dotCount ? config.color : 'var(--border)'}; opacity:${i <= config.dotCount ? 1 : 0.3}"></div>`
              ).join('')}
            </div>
            <span class="crowd-card__label" style="color:${config.color}">${level.charAt(0).toUpperCase() + level.slice(1)}</span>
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
          ${crowd.reason}
        </div>
      </div>
    `;

    document.getElementById('crowdUpdatedAgo').textContent = `AI predicted`;
  }

  // ─── Advice Cards (Smart Recommendations) ─────────────────────────
  let countdownIntervals = [];

  function clearCountdowns() {
    countdownIntervals.forEach(id => clearInterval(id));
    countdownIntervals = [];
  }

  function renderAdvice(adviceData) {
    clearCountdowns();
    const container = document.getElementById('arrivalCards');
    container.innerHTML = '';

    if (!adviceData || !adviceData.options) return;

    const options = adviceData.options;
    const bestIdx = adviceData.bestOption || 0;

    document.getElementById('arrivalCount').textContent = `${options.length} buses`;

    // Global advice
    if (adviceData.globalAdvice) {
      const globalDiv = document.createElement('div');
      globalDiv.className = 'global-advice animate-slide-up';
      globalDiv.innerHTML = `<div class="global-advice__text">${adviceData.globalAdvice}</div>`;
      container.appendChild(globalDiv);
    }

    options.forEach((opt, idx) => {
      const isBest = idx === bestIdx;
      const card = document.createElement('div');
      card.className = `advice-card animate-slide-up ${isBest ? 'recommended' : ''}`;
      card.style.animationDelay = `${idx * 80}ms`;

      // Status
      const statusLabel = {
        'on-time': 'On Time',
        'delayed': 'Delayed',
        'early': 'Early',
      };

      // Stress color
      const stressColors = {
        'Rahat': '#22c55e',
        'Normal': '#f59e0b',
        'Yoğun': '#f97316',
        'Stresli': '#ef4444',
      };
      const stressColor = stressColors[opt.stressLabel] || '#888';

      // Occupancy bar
      const occColor = opt.occupancyPct < 40 ? '#22c55e' : opt.occupancyPct < 70 ? '#f59e0b' : '#ef4444';

      // Crowd level badge
      const crowdColors = {
        empty: '#22c55e', light: '#84cc16', moderate: '#f59e0b',
        busy: '#ef4444', crowded: '#991b1b',
        low: '#22c55e', medium: '#f59e0b', high: '#ef4444',
      };
      const crowdColor = crowdColors[opt.crowdLevel] || '#888';

      // Recommendation chip
      const recPriorityColors = {
        urgent: '#ef4444', critical: '#991b1b', suggestion: '#3b82f6',
        info: '#8b5cf6', ok: '#22c55e', warning: '#f59e0b',
      };
      const recColor = recPriorityColors[opt.recommendation?.priority] || '#3b82f6';

      // Factors
      const factors = opt.factors || [];
      const factorsHTML = factors.length > 0 ? `
        <div class="advice-card__factors">
          ${factors.map(f =>
            `<span class="factor-chip ${f.type}">${f.icon} ${f.label} ${f.impact}</span>`
          ).join('')}
        </div>
      ` : '';

      // Seat turnover
      const turnoverHTML = opt.seatTurnoverNote ? `
        <div class="advice-card__turnover">${opt.seatTurnoverNote}</div>
      ` : '';

      // Last bus badge
      const lastBusBadge = opt.isLastBus ? `<span class="last-bus-badge">Son Sefer</span>` : '';

      // Run badge
      const runBadge = opt.predictedMin <= 2 ? `<span class="run-badge">Kos!</span>` : '';

      const arrivalTime = Date.now() + opt.predictedMin * 60 * 1000;

      card.innerHTML = `
        ${isBest ? '<div class="advice-card__best-tag">En İyi Seçenek</div>' : ''}
        ${lastBusBadge}
        ${runBadge}
        <div class="advice-card__top">
          <div class="advice-card__route-info">
            <span class="advice-card__route-num" style="background:${opt.routeColor}">${opt.routeId}</span>
            <div>
              <div class="advice-card__dest">→ ${opt.destination} <span class="ml-badge">ML</span></div>
              <div class="advice-card__vehicle">${opt.vehicleId}</div>
            </div>
          </div>
          <div class="advice-card__time">
            <div class="advice-card__countdown" id="cd-${idx}" style="color:${opt.routeColor}">
              ${opt.predictedMin}<span class="advice-card__countdown-unit"> dk</span>
            </div>
          </div>
        </div>

        <div class="advice-card__metrics">
          <div class="advice-card__metric">
            <div class="advice-card__metric-label">Yoğunluk</div>
            <span class="advice-card__crowd-badge" style="background:${crowdColor}20;color:${crowdColor};border:1px solid ${crowdColor}40">
              ${opt.crowdLevel}
            </span>
          </div>
          <div class="advice-card__metric">
            <div class="advice-card__metric-label">Doluluk</div>
            <div class="occupancy-bar">
              <div class="occupancy-bar__fill" style="width:${opt.occupancyPct}%;background:${occColor}"></div>
            </div>
            <span class="occupancy-pct">${opt.occupancyPct}%</span>
          </div>
          <div class="advice-card__metric">
            <div class="advice-card__metric-label">Koltuk</div>
            <span style="font-weight:600;color:${opt.seatsAvailable > 10 ? '#22c55e' : opt.seatsAvailable > 0 ? '#f59e0b' : '#ef4444'}">
              ${opt.seatsAvailable}
            </span>
          </div>
          <div class="advice-card__metric">
            <div class="advice-card__metric-label">Stres</div>
            <span class="stress-badge" style="background:${stressColor}20;color:${stressColor};border:1px solid ${stressColor}40">
              ${opt.stressScore} · ${opt.stressLabel}
            </span>
          </div>
        </div>

        <div class="advice-card__bottom">
          <span class="advice-card__status ${opt.status}">${statusLabel[opt.status]}</span>
          <span class="advice-card__scheduled">Planlanan: ${opt.scheduledMin}dk</span>
          ${opt.minutesToNextBus ? `<span class="advice-card__next">Sonraki: ${opt.minutesToNextBus}dk</span>` : ''}
        </div>

        ${turnoverHTML}
        ${factorsHTML}

        ${opt.recommendation ? `
          <div class="recommendation-chip" style="background:${recColor}15;border:1px solid ${recColor}30;color:${recColor}">
            <span class="recommendation-chip__icon">${opt.recommendation.icon}</span>
            <span class="recommendation-chip__text">${opt.recommendation.text}</span>
          </div>
        ` : ''}
      `;

      // Left border color
      card.style.borderLeftColor = opt.routeColor;
      card.style.borderLeftWidth = '3px';
      card.style.borderLeftStyle = 'solid';

      container.appendChild(card);

      // Live countdown
      const cdEl = document.getElementById(`cd-${idx}`);
      if (cdEl) {
        const interval = setInterval(() => {
          const remaining = Math.max(0, Math.round((arrivalTime - Date.now()) / 60000));
          if (remaining <= 0) {
            cdEl.innerHTML = `<span style="color:var(--accent-green)">Geldi!</span>`;
            clearInterval(interval);
          } else if (remaining <= 1) {
            cdEl.innerHTML = `<span style="color:var(--accent-amber)">~1<span class="advice-card__countdown-unit"> dk</span></span>`;
            cdEl.style.animation = 'countdownPulse 1s ease infinite';
          } else {
            cdEl.innerHTML = `${remaining}<span class="advice-card__countdown-unit"> dk</span>`;
          }
        }, 15000);
        countdownIntervals.push(interval);
      }
    });
  }

  // Legacy renderArrivals — delegates to renderAdvice for backward compat
  function renderArrivals(arrivals) {
    // If it's advice data, use the new renderer
    if (arrivals && arrivals.options) {
      renderAdvice(arrivals);
      return;
    }

    // Legacy: convert old arrivals format to advice-like format
    clearCountdowns();
    const container = document.getElementById('arrivalCards');
    container.innerHTML = '';

    document.getElementById('arrivalCount').textContent = `${arrivals.length} buses`;

    const recommended = arrivals.find(a => a.status !== 'delayed' && a.occupancy !== 'high') || arrivals[0];

    arrivals.forEach((arrival, idx) => {
      const isRecommended = arrival === recommended;
      const card = document.createElement('div');
      card.className = `advice-card animate-slide-up ${isRecommended ? 'recommended' : ''}`;
      card.style.animationDelay = `${idx * 60}ms`;

      const statusLabel = {
        'on-time': 'On Time',
        'delayed': 'Delayed',
        'early': 'Early',
      };

      const crowdColors = {
        empty: '#22c55e', light: '#84cc16', moderate: '#f59e0b',
        busy: '#ef4444', crowded: '#991b1b',
        low: '#22c55e', medium: '#f59e0b', high: '#ef4444',
      };
      const crowdColor = crowdColors[arrival.occupancy] || '#888';

      const mlBadge = arrival.mlPowered
        ? `<span class="ml-badge">ML</span>`
        : '';

      const arrivalTime = Date.now() + arrival.predictedMin * 60 * 1000;

      card.innerHTML = `
        ${isRecommended ? '<div class="advice-card__best-tag">Best Option</div>' : ''}
        <div class="advice-card__top">
          <div class="advice-card__route-info">
            <span class="advice-card__route-num" style="background:${arrival.routeColor}">${arrival.routeId}</span>
            <div>
              <div class="advice-card__dest">→ ${arrival.destination} ${mlBadge}</div>
              <div class="advice-card__vehicle">${arrival.vehicleId}</div>
            </div>
          </div>
          <div class="advice-card__time">
            <div class="advice-card__countdown" id="cd-${idx}" style="color:${arrival.routeColor}">
              ${arrival.predictedMin}<span class="advice-card__countdown-unit"> min</span>
            </div>
          </div>
        </div>
        <div class="advice-card__bottom">
          <span class="advice-card__status ${arrival.status}">${statusLabel[arrival.status]}</span>
          <span class="advice-card__crowd-badge" style="background:${crowdColor}20;color:${crowdColor};border:1px solid ${crowdColor}40">${arrival.occupancy}</span>
          <span class="advice-card__scheduled">Sched: ${arrival.scheduledMin}m</span>
        </div>
      `;

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
            cdEl.innerHTML = `<span style="color:var(--accent-amber)">~1<span class="advice-card__countdown-unit"> min</span></span>`;
          } else {
            cdEl.innerHTML = `${remaining}<span class="advice-card__countdown-unit"> min</span>`;
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
        const source = info.dataSource === 'hackathon_real' ? 'Real Sivas Data' : 'Synthetic';
        const classes = info.crowdModel?.numClasses || 3;
        footer.innerHTML = `
          <div class="model-info__badge">
            Random Forest ML · ${source} · ${info.arrivalModel?.trainSamples || 0} samples
          </div>
          <div>
            Arrival MAE: <span class="model-info__stat">${arrMAE} min</span> ·
            Crowd Acc: <span class="model-info__stat">${crowdAcc}%</span> (${classes}-class)
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
    renderAdvice,
    renderModelInfo,
    showArrivalsLoading,
    showCrowdLoading,
    clearCountdowns,
  };
})();
