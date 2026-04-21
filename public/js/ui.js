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

  // Build a leg-by-leg stop list for a single bus (expanded under its card).
  // Uses the cascade projection's per-stop delays on top of the bus's
  // predicted arrival at the user's stop. Assumes ~4 min per segment
  // (matches ml/journey.js AVG_MIN_PER_SEGMENT) plus delay growth.
  function _renderBusPath(cascade, opt, routeColor) {
    const SEG_MIN = 4;
    const arrivalMs = Date.now() + (opt.predictedMin || 0) * 60 * 1000;
    const startDelay = cascade.stops[0].predictedDelay || 0;

    const rows = cascade.stops.map((s, i) => {
      const segDelta = (s.predictedDelay || 0) - startDelay;
      const etaMs = arrivalMs + i * SEG_MIN * 60 * 1000 + segDelta * 60 * 1000;
      const minFromNow = Math.max(0, Math.round((etaMs - Date.now()) / 60000));
      const clock = _formatClock(new Date(etaMs));
      const isHere = i === 0;
      const isEnd = i === cascade.stops.length - 1;
      const dotCls = isHere ? 'here' : isEnd ? 'end' : '';
      const delayTag = s.predictedDelay >= 3
        ? `<span class="bus-path__delay" style="color:${s.color}">+${Math.round(s.predictedDelay)}m</span>`
        : '';
      return `
        <div class="bus-path__row ${isHere ? 'is-here' : ''}">
          <div class="bus-path__rail">
            <span class="bus-path__dot ${dotCls}" style="border-color:${routeColor};background:${isHere ? routeColor : 'var(--bg-card)'}"></span>
            ${!isEnd ? `<span class="bus-path__line" style="background:${routeColor}"></span>` : ''}
          </div>
          <div class="bus-path__info">
            <span class="bus-path__name">${s.stopName}${isHere ? ' <span class="bus-path__here-tag">you are here</span>' : ''}</span>
            ${delayTag}
          </div>
          <div class="bus-path__eta">
            <span class="bus-path__eta-clock">${clock}</span>
            <span class="bus-path__eta-min">${minFromNow} min</span>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="bus-path__header">
        <span>${cascade.stops.length} stops to ${cascade.terminalStopName || 'end'}</span>
        ${cascade.delayGrowth > 2 ? `<span class="bus-path__cascade-note">delay grows +${cascade.delayGrowth} min</span>` : ''}
      </div>
      <div class="bus-path__list">${rows}</div>
    `;
  }

  function renderAdvice(adviceData, fromStopId) {
    clearCountdowns();
    const container = document.getElementById('arrivalCards');
    container.innerHTML = '';

    if (!adviceData || !adviceData.options) return;
    const currentStopId = fromStopId || adviceData.stopId;

    const options = adviceData.options;
    const bestIdx = (typeof adviceData.bestOption === 'number' && adviceData.bestOption >= 0)
      ? adviceData.bestOption
      : -1;

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
        'Relaxed': '#22c55e',
        'Normal': '#f59e0b',
        'Busy': '#f97316',
        'Stressful': '#ef4444',
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
      const lastBusBadge = opt.isLastBus ? `<span class="last-bus-badge">Last Bus</span>` : '';

      // Service-ended badge (night / pre-dawn, no buses until tomorrow)
      const endedBadge = opt.serviceEnded ? `<span class="service-ended-badge">No Service</span>` : '';

      // Run badge (suppressed when service has ended — "run" to a bus hours away makes no sense)
      const runBadge = !opt.serviceEnded && opt.predictedMin <= 2 ? `<span class="run-badge">Run!</span>` : '';

      const arrivalTime = Date.now() + opt.predictedMin * 60 * 1000;

      card.innerHTML = `
        ${isBest ? '<div class="advice-card__best-tag">Best Option</div>' : ''}
        ${endedBadge}
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
            ${opt.serviceEnded ? `
              <div class="advice-card__countdown advice-card__countdown--ended" style="color:#8b5cf6">
                ${opt.firstBusTimeStr || '--:--'}
              </div>
            ` : `
              <div class="advice-card__countdown" id="cd-${idx}" style="color:${opt.routeColor}">
                ${opt.predictedMin}<span class="advice-card__countdown-unit"> min</span>
              </div>
            `}
          </div>
        </div>

        <div class="advice-card__metrics">
          <div class="advice-card__metric">
            <div class="advice-card__metric-label">Crowd</div>
            <span class="advice-card__crowd-badge" style="background:${crowdColor}20;color:${crowdColor};border:1px solid ${crowdColor}40">
              ${opt.crowdLevel}
            </span>
          </div>
          <div class="advice-card__metric">
            <div class="advice-card__metric-label">Fill</div>
            <div class="occupancy-bar">
              <div class="occupancy-bar__fill" style="width:${opt.occupancyPct}%;background:${occColor}"></div>
            </div>
            <span class="occupancy-pct">${opt.occupancyPct}%</span>
          </div>
          <div class="advice-card__metric">
            <div class="advice-card__metric-label">Seats</div>
            <span style="font-weight:600;color:${opt.seatsAvailable > 10 ? '#22c55e' : opt.seatsAvailable > 0 ? '#f59e0b' : '#ef4444'}">
              ${opt.seatsAvailable}
            </span>
          </div>
          <div class="advice-card__metric">
            <div class="advice-card__metric-label">Stress</div>
            <span class="stress-badge" style="background:${stressColor}20;color:${stressColor};border:1px solid ${stressColor}40">
              ${opt.stressScore} · ${opt.stressLabel}
            </span>
          </div>
        </div>

        <div class="advice-card__bottom">
          <span class="advice-card__status ${opt.status}">${statusLabel[opt.status]}</span>
          <span class="advice-card__scheduled">Scheduled: ${opt.scheduledMin}m</span>
          ${opt.minutesToNextBus ? `<span class="advice-card__next">Next: ${opt.minutesToNextBus}m</span>` : ''}
        </div>

        ${turnoverHTML}
        ${factorsHTML}

        ${opt.recommendation ? `
          <div class="recommendation-chip" style="background:${recColor}15;border:1px solid ${recColor}30;color:${recColor}">
            <span class="recommendation-chip__icon">${opt.recommendation.icon}</span>
            <span class="recommendation-chip__text">${opt.recommendation.text}</span>
          </div>
        ` : ''}

        <button type="button" class="advice-card__path-toggle" data-role="path-toggle" aria-expanded="false">
          <span class="advice-card__path-toggle-label">Show stops on this bus</span>
          <span class="advice-card__path-toggle-chev" aria-hidden="true">▾</span>
        </button>
        <div class="advice-card__path" data-role="path-body" hidden></div>
      `;

      // Left border color
      card.style.borderLeftColor = opt.routeColor;
      card.style.borderLeftWidth = '3px';
      card.style.borderLeftStyle = 'solid';

      // Bus-path expand/collapse — lazy-loads cascade stops for this route.
      const pathToggle = card.querySelector('[data-role="path-toggle"]');
      const pathBody = card.querySelector('[data-role="path-body"]');
      if (pathToggle && pathBody && currentStopId && !opt.serviceEnded) {
        pathToggle.addEventListener('click', async (e) => {
          e.stopPropagation();
          const expanded = pathToggle.getAttribute('aria-expanded') === 'true';
          if (expanded) {
            pathBody.hidden = true;
            pathToggle.setAttribute('aria-expanded', 'false');
            pathToggle.querySelector('.advice-card__path-toggle-label').textContent = 'Show stops on this bus';
            return;
          }
          pathToggle.setAttribute('aria-expanded', 'true');
          pathToggle.querySelector('.advice-card__path-toggle-label').textContent = 'Hide stops';
          pathBody.hidden = false;
          if (!pathBody.dataset.loaded) {
            pathBody.innerHTML = `<div class="advice-card__path-loading">Loading stops…</div>`;
            try {
              const cascade = await DataService.getCascade(opt.routeId, currentStopId);
              if (!cascade || !Array.isArray(cascade.stops) || cascade.stops.length < 2) {
                pathBody.innerHTML = `<div class="advice-card__path-empty">No downstream stops.</div>`;
                return;
              }
              pathBody.innerHTML = _renderBusPath(cascade, opt, opt.routeColor);
              pathBody.dataset.loaded = '1';
            } catch (err) {
              pathBody.innerHTML = `<div class="advice-card__path-empty">Could not load stops.</div>`;
            }
          }
        });
      } else if (pathToggle) {
        pathToggle.style.display = 'none';
      }

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
            cdEl.style.animation = 'countdownPulse 1s ease infinite';
          } else {
            cdEl.innerHTML = `${remaining}<span class="advice-card__countdown-unit"> min</span>`;
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
            ${arrival.etaBandMin ? `
              <div class="advice-card__eta-band" title="Random-forest tree disagreement — higher spread means less certain.">
                ±${arrival.etaBandMin} min · ${arrival.confidence}%
              </div>
            ` : ''}
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
  // Polls /api/model/info until the RF models finish training, so the
  // footer updates live from "Loading..." → real MAE/accuracy instead
  // of showing a stale placeholder if the page loads mid-train.
  let _modelInfoPollTimer = null;
  async function renderModelInfo() {
    const footer = document.getElementById('modelInfo');
    if (!footer) return;

    async function tick() {
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
          if (_modelInfoPollTimer) { clearInterval(_modelInfoPollTimer); _modelInfoPollTimer = null; }
          return true;
        }
        // Still training — keep the loading badge visible and poll again.
        footer.innerHTML = `
          <div class="model-info__badge">ML Engine Training... (Random Forest)</div>
          <div style="opacity:.7">Models warming up — a few seconds.</div>
        `;
        return false;
      } catch (e) {
        return false;
      }
    }

    const done = await tick();
    if (!done && !_modelInfoPollTimer) {
      _modelInfoPollTimer = setInterval(async () => {
        const finished = await tick();
        if (finished && _modelInfoPollTimer) {
          clearInterval(_modelInfoPollTimer);
          _modelInfoPollTimer = null;
        }
      }, 2000);
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

  // ─── Journey Cards ──────────────────────────────────────────────────

  function setArrivalSectionMode(mode, count) {
    const title = document.getElementById('arrivalSectionTitle');
    const badge = document.getElementById('arrivalCount');
    if (mode === 'journey') {
      if (title) title.textContent = 'Journey Plan';
      if (badge) badge.textContent = count != null ? `${count} options` : '--';
    } else {
      if (title) title.textContent = 'Upcoming Arrivals';
      if (badge) badge.textContent = count != null ? `${count} buses` : '--';
    }
  }

  function renderJourney(journeyData) {
    clearCountdowns();
    const container = document.getElementById('arrivalCards');
    container.innerHTML = '';

    if (!journeyData) return;

    // No path found
    if (!journeyData.legs || journeyData.legs.length === 0) {
      setArrivalSectionMode('journey', 0);
      container.innerHTML = `
        <div class="journey-empty animate-fade-in">
          <div class="journey-empty__icon">🚫</div>
          <div class="journey-empty__title">${journeyData.message || 'No route found'}</div>
          <div class="journey-empty__desc">
            No valid route between
            ${journeyData.from?.name || ''} → ${journeyData.to?.name || ''}.
          </div>
        </div>
      `;
      return;
    }

    setArrivalSectionMode('journey', journeyData.busStopCount + ' stops');

    // ─── Hero Banner ──────────────────────────────────────────
    const banner = document.createElement('div');
    banner.className = 'journey-mode-banner animate-fade-in';

    const routeBadges = journeyData.legs
      .filter(l => l.type === 'bus')
      .map(l => `<span class="journey-card__route-num" style="background:${l.routeColor};font-size:11px;padding:2px 8px">${l.routeId}</span>`)
      .join('<span style="color:var(--text-muted);margin:0 2px">→</span>');

    const heroTime = journeyData.serviceEnded
      ? `<span style="color:#8b5cf6">${journeyData.firstBusTimeStr || 'No Service'}</span>`
      : `<span style="font-size:1.6rem;font-weight:800;color:var(--accent-blue)">${journeyData.totalMin}<span style="font-size:0.7rem"> min</span></span>`;

    banner.innerHTML = `
      <div style="flex:1">
        <div class="journey-mode-banner__text">
          <span>${journeyData.from?.name || '...'}</span> → <span>${journeyData.to?.name || '...'}</span>
        </div>
        <div style="margin-top:4px;display:flex;align-items:center;gap:4px">
          ${routeBadges}
          ${journeyData.hasTransfer ? '<span style="font-size:10px;color:var(--text-muted);margin-left:4px">🔄 Transfer</span>' : ''}
        </div>
      </div>
      <div style="text-align:right">${heroTime}</div>
    `;
    container.appendChild(banner);

    // ─── Recommendation Chip ─────────────────────────────────
    const rec = journeyData.recommendation;
    if (rec) {
      const recPriorityColors = {
        urgent: '#ef4444', critical: '#991b1b', suggestion: '#3b82f6',
        info: '#8b5cf6', ok: '#22c55e', warning: '#f59e0b',
      };
      const recColor = recPriorityColors[rec.priority] || '#3b82f6';
      const chip = document.createElement('div');
      chip.className = 'recommendation-chip animate-slide-up';
      chip.style.cssText = `background:${recColor}15;border:1px solid ${recColor}30;color:${recColor};margin-bottom:12px`;
      chip.innerHTML = `<span class="recommendation-chip__icon">${rec.icon}</span><span class="recommendation-chip__text">${rec.text}</span>`;
      container.appendChild(chip);
    }

    // ─── Leg-by-Leg Path View ─────────────────────────────────
    const pathCard = document.createElement('div');
    pathCard.className = 'journey-path-card animate-slide-up';

    let pathHTML = '<div class="journey-path">';

    journeyData.legs.forEach((leg, legIdx) => {
      if (leg.type === 'bus') {
        // Bus leg header
        pathHTML += `
          <div class="journey-path__leg-header">
            <span class="journey-card__route-num" style="background:${leg.routeColor};font-size:11px;padding:2px 8px">${leg.routeId}</span>
            <span style="font-size:var(--fs-xs);color:var(--text-secondary)">${leg.routeName}</span>
            <span style="font-size:var(--fs-xs);color:var(--text-muted);margin-left:auto">
              ${leg.waitMin != null ? leg.waitMin + ' min wait + ' : ''}${leg.rideMin} min
            </span>
          </div>
        `;
        // Stop list
        leg.stops.forEach((stop, si) => {
          const isFirst = si === 0;
          const isLast = si === leg.stops.length - 1;
          const dotClass = isFirst ? 'origin' : isLast ? 'dest' : '';
          pathHTML += `
            <div class="journey-path__stop ${dotClass}">
              <div class="journey-path__dot" style="border-color:${leg.routeColor}"></div>
              <div class="journey-path__line" style="background:${leg.routeColor}"></div>
              <span class="journey-path__stop-name">${stop.name}</span>
            </div>
          `;
        });
      } else {
        // Transfer leg (walk / dolmus)
        const icon = leg.type === 'dolmus' ? '🚐' : '🚶';
        const label = leg.type === 'dolmus'
          ? `Minibus/taxi ${(leg.distM/1000).toFixed(1)}km (${leg.transferMin} min)`
          : `Walk ${leg.distM}m (${leg.transferMin} min)${leg.routed ? '' : ''}`;
        pathHTML += `
          <div class="journey-path__transfer">
            <div class="journey-path__transfer-icon">${icon}</div>
            <span>${label}</span>
          </div>
        `;
      }
    });

    pathHTML += '</div>';
    pathCard.innerHTML = pathHTML;
    container.appendChild(pathCard);

    // ML badge
    if (journeyData.mlPowered) {
      const mlDiv = document.createElement('div');
      mlDiv.style.cssText = 'text-align:center;margin-top:8px;font-size:10px;color:var(--text-muted)';
      mlDiv.innerHTML = '<span class="ml-badge">ML</span> Wait time is ML-predicted';
      container.appendChild(mlDiv);
    }
  }

  // ─── Delay Cascade Badge ────────────────────────────────────────────
  // Renders a compact card under the route badges in the side panel that
  // tells the rider how delay is expected to grow as they ride downstream.
  function renderCascade(cascadeData) {
    const container = document.getElementById('cascadeCard');
    if (!container) return;
    if (!cascadeData || !cascadeData.stops || cascadeData.stops.length < 2) {
      container.innerHTML = '';
      container.style.display = 'none';
      return;
    }

    const start = cascadeData.startDelay;
    const end = cascadeData.endDelay;
    const growth = cascadeData.delayGrowth;
    const endColor = cascadeData.stops[cascadeData.stops.length - 1].color;
    const startColor = cascadeData.stops[0].color;

    // Tiny inline severity bars — one per downstream stop
    const bars = cascadeData.stops.map(s => `
      <div class="cascade-bar"
           style="background:${s.color}"
           title="${s.stopName}: +${s.predictedDelay} min"></div>
    `).join('');

    const headline = cascadeData.firstSevereStop
      ? `+${cascadeData.firstSevereStop.delay} min by <strong>${cascadeData.firstSevereStop.name}</strong>`
      : `+${end} min by end of line`;

    container.style.display = 'block';
    container.innerHTML = `
      <div class="cascade-card animate-fade-in">
        <div class="cascade-card__header">
          <span class="cascade-card__title">Delay Cascade · ${cascadeData.routeId}</span>
          <span class="cascade-card__badge" style="color:${endColor};border-color:${endColor}">+${growth} min</span>
        </div>
        <div class="cascade-card__bars">${bars}</div>
        <div class="cascade-card__legend">
          <span style="color:${startColor}">${start} min</span>
          <span class="cascade-card__legend-arrow">→</span>
          <span style="color:${endColor}">${end} min</span>
          <span class="cascade-card__legend-stops">· ${cascadeData.downstreamStopCount} stops</span>
        </div>
        <div class="cascade-card__hint">${headline}</div>
      </div>
    `;
  }

  function clearCascade() {
    const container = document.getElementById('cascadeCard');
    if (container) {
      container.innerHTML = '';
      container.style.display = 'none';
    }
  }

  // ─── Leave-by Advisor ───────────────────────────────────────────────
  // Pure presentation: takes the same advice payload the arrivals card
  // uses, plus the user's walking time, and answers "when should I leave?"
  // Inspired by Google Maps' transit results — preset pills + custom min,
  // then 2-4 leave-by options ranked from soonest to last reasonable.

  function _crowdToTag(level) {
    const seat     = ['empty', 'low', 'light'];
    const standing = ['moderate', 'medium'];
    const packed   = ['busy', 'high', 'crowded'];
    if (seat.includes(level))     return { cls: 'seat',     label: 'Seat available' };
    if (standing.includes(level)) return { cls: 'standing', label: 'Standing room' };
    if (packed.includes(level))   return { cls: 'packed',   label: 'Packed' };
    return { cls: 'standing', label: '—' };
  }

  function _formatClock(date) {
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }

  // Builds leave-by candidates from the advice payload. Each option yields
  // both the primary bus and (if available) a synthesized "next bus" using
  // minutesToNextBus, so long walk times still surface reachable buses.
  // Prefers catchable candidates; falls back to the soonest upcoming ones
  // with a "missed" flag so the card is never empty.
  function _pickLeaveOptions(adviceData, walkMin) {
    if (!adviceData || !adviceData.options) return [];
    const candidates = [];
    adviceData.options
      .filter(opt => !opt.serviceEnded && typeof opt.predictedMin === 'number')
      .forEach(opt => {
        // Prefer the full upcoming-buses array from the predictor so we can
        // surface bus #1 / #2 / #3 for long walk times. Keep bus #1 on the
        // ML-predicted minute and carry the same delay offset forward to the
        // later scheduled entries.
        const future = Array.isArray(opt.futureBusMins) ? opt.futureBusMins : null;
        if (future && future.length > 0) {
          const baseSched = future[0];
          future.forEach((schedMin, i) => {
            const predMin = i === 0
              ? opt.predictedMin
              : opt.predictedMin + (schedMin - baseSched);
            candidates.push({
              opt,
              predictedMin: predMin,
              leaveInMin: predMin - walkMin,
              busIndex: i,
            });
          });
          return;
        }

        // Legacy fallback: primary + synthesized next bus via minutesToNextBus.
        candidates.push({
          opt,
          predictedMin: opt.predictedMin,
          leaveInMin: opt.predictedMin - walkMin,
          busIndex: 0,
        });
        if (typeof opt.minutesToNextBus === 'number' && opt.minutesToNextBus > 0) {
          const nextMin = opt.predictedMin + opt.minutesToNextBus;
          candidates.push({
            opt,
            predictedMin: nextMin,
            leaveInMin: nextMin - walkMin,
            busIndex: 1,
          });
        }
      });

    const catchable = candidates
      .filter(c => c.leaveInMin >= -1)
      .sort((a, b) => a.leaveInMin - b.leaveInMin);
    if (catchable.length > 0) return catchable.slice(0, 3);

    // Nothing catchable — surface the soonest upcoming buses as "missed"
    // so the user sees when the next service actually is.
    return candidates
      .map(c => ({ ...c, missed: true }))
      .sort((a, b) => a.predictedMin - b.predictedMin)
      .slice(0, 3);
  }

  function _setLeaveSummary(text) {
    const el = document.getElementById('leaveCollapseSummary');
    if (el) el.textContent = text || '';
  }

  function renderLeaveAdvisor(adviceData, walkMin) {
    const container = document.getElementById('leaveAdvisorCard');
    const slot = document.getElementById('leaveOptions');
    if (!container || !slot) return;

    // Service ended — show a single explanatory row instead of nothing
    const serviceEnded = adviceData
      && adviceData.options
      && adviceData.options.length > 0
      && adviceData.options.every(o => o.serviceEnded);

    if (serviceEnded) {
      const first = adviceData.options[0];
      container.style.display = 'block';
      _setLeaveSummary(`No service · first bus ${first.firstBusTimeStr || '--:--'}`);
      slot.innerHTML = `
        <div class="leave-option leave-option--ended">
          <div class="leave-option__time">
            <span class="leave-option__time-label">First bus</span>
            <span class="leave-option__time-value">${first.firstBusTimeStr || '--:--'}</span>
          </div>
          <div class="leave-option__body">
            <span class="leave-option__bus">No service tonight</span>
            <span class="leave-option__tag">Starts tomorrow at ${first.firstBusTimeStr || ''}</span>
          </div>
        </div>
      `;
      return;
    }

    const picks = _pickLeaveOptions(adviceData, walkMin);
    if (picks.length === 0) {
      container.style.display = 'block';
      _setLeaveSummary('No buses coming soon');
      slot.innerHTML = `<div class="leave-empty">No buses coming soon.</div>`;
      return;
    }

    container.style.display = 'block';

    // Summary shown when the card is collapsed — best (soonest) option.
    const best = picks[0];
    if (best) {
      const now = Date.now();
      if (best.missed) {
        _setLeaveSummary('Missed · check alternatives');
      } else if (best.leaveInMin <= 0) {
        _setLeaveSummary(`Go now · ${best.opt.routeId} in ${best.predictedMin} min`);
      } else {
        const leaveClock = _formatClock(new Date(now + best.leaveInMin * 60 * 1000));
        _setLeaveSummary(`Leave ${leaveClock} · ${best.opt.routeId} (${walkMin} min walk)`);
      }
    }

    const now = Date.now();
    slot.innerHTML = picks.map(({ opt, predictedMin, leaveInMin, busIndex, missed }) => {
      const tag = _crowdToTag(opt.crowdLevel || opt.occupancy);
      const leaveTs = now + leaveInMin * 60 * 1000;
      const arrivalTs = now + predictedMin * 60 * 1000;

      let timeLabel = 'Leave';
      let timeValue = _formatClock(new Date(leaveTs));
      let timeValueCls = '';
      if (missed) {
        timeLabel = 'Missed';
        timeValue = 'Too late';
        timeValueCls = 'leave-option__time-value--now';
      } else if (leaveInMin <= 0) {
        timeLabel = 'Now';
        timeValue = 'Go!';
        timeValueCls = 'leave-option__time-value--now';
      } else if (leaveInMin <= 3) {
        timeValueCls = 'leave-option__time-value--soon';
      }

      const routeStyle = opt.routeColor ? `background:${opt.routeColor}` : '';
      const busLabel = busIndex === 0 ? 'Bus'
        : busIndex === 1 ? 'Next bus'
        : `Bus #${busIndex + 1}`;
      return `
        <div class="leave-option leave-option--${tag.cls} animate-fade-in">
          <div class="leave-option__time">
            <span class="leave-option__time-label">${timeLabel}</span>
            <span class="leave-option__time-value ${timeValueCls}">${timeValue}</span>
          </div>
          <div class="leave-option__body">
            <span class="leave-option__bus">
              <span class="leave-option__route" style="${routeStyle}">${opt.routeId}</span>
              ${busLabel} <span class="leave-option__arrival">${_formatClock(new Date(arrivalTs))}</span>
              · ${predictedMin} min away
            </span>
            <span class="leave-option__tag">${tag.label}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  function clearLeaveAdvisor() {
    const container = document.getElementById('leaveAdvisorCard');
    if (container) {
      container.style.display = 'none';
      // Reset to collapsed so next stop selection shows the crowd card
      container.classList.add('is-collapsed');
      const toggle = document.getElementById('leaveCollapseToggle');
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    }
    _setLeaveSummary('');
  }

  // ─── Schedule-a-Ride rendering ─────────────────────────────────────
  function showPlanLoading() {
    const container = document.getElementById('leaveAdvisorCard');
    const slot = document.getElementById('leaveOptions');
    if (!container || !slot) return;
    container.style.display = 'block';
    _setLeaveSummary('Checking the schedule…');
    slot.innerHTML = `<div class="leave-empty">Checking the schedule…</div>`;
  }

  function _tierLabel(tier) {
    if (tier === 'same-day') return { label: 'ML · today', cls: 'tier-day' };
    if (tier === 'same-week') return { label: 'ML · this week', cls: 'tier-week' };
    return { label: 'Schedule-based', cls: 'tier-future' };
  }

  function _formatClockFromIso(iso) {
    try { return _formatClock(new Date(iso)); } catch (_) { return '--:--'; }
  }

  function renderPlanOptions(data, walkOffsetMin) {
    const container = document.getElementById('leaveAdvisorCard');
    const slot = document.getElementById('leaveOptions');
    if (!container || !slot) return;
    container.style.display = 'block';

    if (!data || !Array.isArray(data.options) || data.options.length === 0) {
      _setLeaveSummary('No buses in this window');
      slot.innerHTML = `<div class="leave-empty">No buses in this window. Try widening it or pick another time.</div>`;
      return;
    }

    const picks = data.options.slice(0, 4);
    const bestIdx = Number.isInteger(data.bestMatch) ? data.bestMatch : 0;
    const targetMs = new Date(data.targetTime).getTime();
    const bestPick = picks[bestIdx] || picks[0];
    if (bestPick) {
      _setLeaveSummary(`Arrive ${_formatClockFromIso(bestPick.predictedAt)} · ${bestPick.routeId}`);
    }

    slot.innerHTML = picks.map((opt, i) => {
      const tag = _crowdToTag(opt.crowdLevel);
      const tier = _tierLabel(opt.accuracyTier);
      const predictedClock = _formatClockFromIso(opt.predictedAt);
      const diff = Math.round(opt.diffFromTargetMin);
      const diffTxt = opt.diffSign === 'early'
        ? `${diff} min early`
        : opt.diffSign === 'late' ? `${diff} min late` : 'on time';

      // Leave-by chip: predicted arrival minus walk offset.
      const leaveByMs = new Date(opt.predictedAt).getTime() - (walkOffsetMin || 0) * 60 * 1000;
      const leaveByClock = _formatClock(new Date(leaveByMs));
      const leaveInMin = Math.round((leaveByMs - Date.now()) / 60000);
      const leaveChip = leaveInMin > 0
        ? `Leave by ${leaveByClock} (${leaveInMin} min)`
        : `Leave now · ${leaveByClock}`;

      const routeStyle = opt.routeColor ? `background:${opt.routeColor}` : '';
      const bestCls = i === bestIdx ? ' leave-option--best' : '';
      return `
        <div class="leave-option leave-option--${tag.cls}${bestCls} animate-fade-in">
          <div class="leave-option__time">
            <span class="leave-option__time-label">Arrive</span>
            <span class="leave-option__time-value">${predictedClock}</span>
          </div>
          <div class="leave-option__body">
            <span class="leave-option__bus">
              <span class="leave-option__route" style="${routeStyle}">${opt.routeId}</span>
              ${diffTxt} · scheduled ${_formatClockFromIso(opt.scheduledAt)}
            </span>
            <div class="plan-chips">
              <span class="plan-chip plan-chip--leave">${leaveChip}</span>
              <span class="plan-chip plan-chip--${tier.cls}">${tier.label}</span>
              <span class="leave-option__tag">${tag.label}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Silence unused var warning + keep for future target-line overlay
    void targetMs;
  }

  return {
    renderWeather,
    renderSearchResults,
    showPanelEmpty,
    showPanelContent,
    renderCrowd,
    renderArrivals,
    renderAdvice,
    renderJourney,
    renderCascade,
    clearCascade,
    renderLeaveAdvisor,
    clearLeaveAdvisor,
    showPlanLoading,
    renderPlanOptions,
    renderModelInfo,
    showArrivalsLoading,
    showCrowdLoading,
    clearCountdowns,
    setArrivalSectionMode,
  };
})();
