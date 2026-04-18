// ─── Map Controller ─────────────────────────────────────────────────────

const MapController = (() => {
  let map;
  let markers = {};
  let routePolylines = [];
  let journeyHighlights = [];
  let cascadeLayers = [];
  let selectedStopId = null;
  let onStopSelect = null;
  let citiesMap = {};

  const BUS_ICON_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V6h12v5z"/></svg>`;

  function createStopIcon(isSelected) {
    return L.divIcon({
      className: '',
      html: `<div class="stop-marker ${isSelected ? 'selected' : ''}">${BUS_ICON_SVG}</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
      popupAnchor: [0, -20],
    });
  }

  function setCities(cities) {
    citiesMap = {};
    cities.forEach(c => {
      citiesMap[c.name] = { lat: c.lat, lng: c.lng, zoom: c.zoom || 13 };
    });
  }

  function init(containerId, onSelect, defaultCenter) {
    onStopSelect = onSelect;

    const city = defaultCenter || { lat: 41.0082, lng: 28.9784, zoom: 13 };
    map = L.map(containerId, {
      center: [city.lat, city.lng],
      zoom: city.zoom || 13,
      zoomControl: true,
      attributionControl: true,
    });

    // Light tile layer
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map);

    // Position zoom controls
    map.zoomControl.setPosition('bottomright');
  }

  function renderStops(stops) {
    // Clear old markers
    Object.values(markers).forEach(m => map.removeLayer(m));
    markers = {};

    stops.forEach(stop => {
      const isSelected = stop.id === selectedStopId;
      const marker = L.marker([stop.lat, stop.lng], {
        icon: createStopIcon(isSelected),
      });

      marker.bindPopup(`
        <div style="min-width:160px;">
          <strong style="font-size:14px;">${stop.name}</strong>
          <div style="color:#6b7280;font-size:11px;margin:4px 0;">${stop.city}</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;">
            ${stop.routes.map(r => `<span style="background:rgba(240,84,122,0.12);color:#F0547A;padding:1px 6px;border-radius:10px;font-size:11px;font-weight:600;">${r}</span>`).join('')}
          </div>
        </div>
      `, { closeButton: false });

      marker.on('click', () => {
        selectStop(stop.id);
      });

      marker.addTo(map);
      markers[stop.id] = marker;
    });
  }

  function selectStop(stopId) {
    const prevId = selectedStopId;
    selectedStopId = stopId;

    // Update icons
    if (prevId && markers[prevId]) {
      markers[prevId].setIcon(createStopIcon(false));
    }
    if (markers[stopId]) {
      markers[stopId].setIcon(createStopIcon(true));
      markers[stopId].closePopup();

      const ll = markers[stopId].getLatLng();
      map.flyTo([ll.lat, ll.lng], Math.max(map.getZoom(), 14), {
        duration: 0.8,
      });
    }

    if (onStopSelect) onStopSelect(stopId);
  }

  function flyToCity(cityName) {
    const city = citiesMap[cityName];
    if (city) {
      map.flyTo([city.lat, city.lng], city.zoom || 13, { duration: 1.2 });
    }
  }

  function drawRoutes(routes, allStops) {
    // Clear previous
    routePolylines.forEach(p => map.removeLayer(p));
    routePolylines = [];

    routes.forEach(route => {
      const coords = route.stops
        .map(sid => allStops.find(s => s.id === sid))
        .filter(Boolean)
        .map(s => [s.lat, s.lng]);

      if (coords.length >= 2) {
        const polyline = L.polyline(coords, {
          color: route.color,
          weight: 3,
          opacity: 0.4,
          dashArray: '8 6',
        }).addTo(map);
        routePolylines.push(polyline);
      }
    });
  }

  function getSelectedStopId() {
    return selectedStopId;
  }

  function highlightJourney(journeyData) {
    clearJourneyHighlight();

    if (!journeyData || !journeyData.legs || journeyData.legs.length === 0) return;
    if (journeyData.serviceEnded) return;

    const allCoords = [];

    // Draw each leg as a separate polyline with appropriate style
    for (const leg of journeyData.legs) {
      if (leg.type === 'bus' && leg.stops) {
        // Use pathCoords to get lat/lng for each stop in this leg
        const coords = [];
        for (const s of leg.stops) {
          const pc = (journeyData.pathCoords || []).find(p => p.id === s.id);
          if (pc) coords.push([pc.lat, pc.lng]);
        }
        if (coords.length >= 2) {
          const line = L.polyline(coords, {
            color: leg.routeColor || '#4f8cff',
            weight: 5,
            opacity: 0.85,
          }).addTo(map);
          journeyHighlights.push(line);
          allCoords.push(...coords);
        }
      } else if (leg.from && leg.to) {
        // Transfer: dashed line between transfer stops
        const fromPc = (journeyData.pathCoords || []).find(p => p.id === leg.from.id);
        const toPc = (journeyData.pathCoords || []).find(p => p.id === leg.to.id);
        if (fromPc && toPc) {
          const coords = [[fromPc.lat, fromPc.lng], [toPc.lat, toPc.lng]];
          const line = L.polyline(coords, {
            color: '#f59e0b',
            weight: 4,
            opacity: 0.7,
            dashArray: '8 8',
          }).addTo(map);
          journeyHighlights.push(line);
          allCoords.push(...coords);
        }
      }
    }

    // Fit map to show entire journey path
    if (allCoords.length >= 2) {
      const bounds = L.latLngBounds(allCoords);
      map.fitBounds(bounds.pad(0.2), { duration: 0.8, maxZoom: 15 });
    }
  }

  function clearJourneyHighlight() {
    journeyHighlights.forEach(l => map.removeLayer(l));
    journeyHighlights = [];
  }

  // ─── Delay Cascade Overlay ──────────────────────────────────────────
  // Draws each downstream segment of a route in the predicted-delay color
  // (green→red), with small numeric badges showing the delay at every stop.
  function showCascade(cascadeData) {
    clearCascade();
    if (!cascadeData || !cascadeData.stops || cascadeData.stops.length < 2) return;

    const stops = cascadeData.stops;

    // Segments between consecutive stops, colored by the *destination* stop's severity
    for (let i = 0; i < stops.length - 1; i++) {
      const from = stops[i];
      const to = stops[i + 1];
      const seg = L.polyline(
        [[from.lat, from.lng], [to.lat, to.lng]],
        {
          color: to.color,
          weight: 6,
          opacity: 0.85,
          lineCap: 'round',
        }
      ).addTo(map);
      seg.bindTooltip(
        `<strong>${to.stopName}</strong><br>Beklenen gecikme: <b style="color:${to.color}">+${to.predictedDelay} dk</b>`,
        { sticky: true, className: 'cascade-tooltip' }
      );
      cascadeLayers.push(seg);
    }

    // Numeric delay pins on each downstream stop (skip the origin)
    for (let i = 1; i < stops.length; i++) {
      const s = stops[i];
      const pin = L.divIcon({
        className: '',
        html: `<div class="cascade-pin" style="background:${s.color};border-color:${s.color}">+${Math.round(s.predictedDelay)}</div>`,
        iconSize: [38, 22],
        iconAnchor: [19, 11],
      });
      const m = L.marker([s.lat, s.lng], { icon: pin, interactive: false, keyboard: false });
      m.addTo(map);
      cascadeLayers.push(m);
    }
  }

  function clearCascade() {
    cascadeLayers.forEach(l => map.removeLayer(l));
    cascadeLayers = [];
  }

  return { init, setCities, renderStops, selectStop, flyToCity, drawRoutes, getSelectedStopId, highlightJourney, clearJourneyHighlight, showCascade, clearCascade };
})();
