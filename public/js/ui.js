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

      // Service-ended badge (night / pre-dawn, no buses until tomorrow)
      const endedBadge = opt.serviceEnded ? `<span class="service-ended-badge">Sefer Yok</span>` : '';

      // Run badge (suppressed when service has ended — "koş" to a bus hours away makes no sense)
      const runBadge = !opt.serviceEnded && opt.predictedMin <= 2 ? `<span class="run-badge">Koş!</span>` : '';

      const arrivalTime = Date.now() + opt.predictedMin * 60 * 1000;

      card.innerHTML = `
        ${isBest ? '<div class="advice-card__best-tag">En İyi Seçenek</div>' : ''}
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
                ${opt.predictedMin}<span class="advice-card__countdown-unit"> dk</span>
              </div>
            `}
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
          <div style="opacity:.7">Modeller hazırlanıyor — birkaç saniye sürebilir.</div>
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
      if (title) title.textContent = 'Yolculuk Planı';
      if (badge) badge.textContent = count != null ? `${count} seçenek` : '--';
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
          <div class="journey-empty__title">${journeyData.message || 'Güzergah bulunamadı'}</div>
          <div class="journey-empty__desc">
            ${journeyData.from?.name || ''} → ${journeyData.to?.name || ''} arasında
            uygun güzergah yok.
          </div>
        </div>
      `;
      return;
    }

    setArrivalSectionMode('journey', journeyData.busStopCount + ' durak');

    // ─── Hero Banner ──────────────────────────────────────────
    const banner = document.createElement('div');
    banner.className = 'journey-mode-banner animate-fade-in';

    const routeBadges = journeyData.legs
      .filter(l => l.type === 'bus')
      .map(l => `<span class="journey-card__route-num" style="background:${l.routeColor};font-size:11px;padding:2px 8px">${l.routeId}</span>`)
      .join('<span style="color:var(--text-muted);margin:0 2px">→</span>');

    const heroTime = journeyData.serviceEnded
      ? `<span style="color:#8b5cf6">${journeyData.firstBusTimeStr || 'Sefer Yok'}</span>`
      : `<span style="font-size:1.6rem;font-weight:800;color:var(--accent-blue)">${journeyData.totalMin}<span style="font-size:0.7rem"> dk</span></span>`;

    banner.innerHTML = `
      <div style="flex:1">
        <div class="journey-mode-banner__text">
          <span>${journeyData.from?.name || '...'}</span> → <span>${journeyData.to?.name || '...'}</span>
        </div>
        <div style="margin-top:4px;display:flex;align-items:center;gap:4px">
          ${routeBadges}
          ${journeyData.hasTransfer ? '<span style="font-size:10px;color:var(--text-muted);margin-left:4px">🔄 Aktarmalı</span>' : ''}
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
              ${leg.waitMin != null ? leg.waitMin + ' dk bekle + ' : ''}${leg.rideMin} dk
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
          ? `${leg.transferMin} dk dolmuş/taksi (${(leg.distM/1000).toFixed(1)}km)`
          : `${leg.transferMin} dk yürüyüş (${leg.distM}m)`;
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
      mlDiv.innerHTML = '<span class="ml-badge">ML</span> Bekleme süresi ML tahminidir';
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
           title="${s.stopName}: +${s.predictedDelay} dk"></div>
    `).join('');

    const headline = cascadeData.firstSevereStop
      ? `<strong>${cascadeData.firstSevereStop.name}</strong>'a kadar +${cascadeData.firstSevereStop.delay} dk`
      : `Hat sonuna kadar +${end} dk`;

    container.style.display = 'block';
    container.innerHTML = `
      <div class="cascade-card animate-fade-in">
        <div class="cascade-card__header">
          <span class="cascade-card__title">Gecikme Yayılımı · ${cascadeData.routeId}</span>
          <span class="cascade-card__badge" style="color:${endColor};border-color:${endColor}">+${growth} dk</span>
        </div>
        <div class="cascade-card__bars">${bars}</div>
        <div class="cascade-card__legend">
          <span style="color:${startColor}">${start} dk</span>
          <span class="cascade-card__legend-arrow">→</span>
          <span style="color:${endColor}">${end} dk</span>
          <span class="cascade-card__legend-stops">· ${cascadeData.downstreamStopCount} durak</span>
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
    renderModelInfo,
    showArrivalsLoading,
    showCrowdLoading,
    clearCountdowns,
    setArrivalSectionMode,
  };
})();
