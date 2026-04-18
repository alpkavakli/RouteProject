// ─── Data Service ───────────────────────────────────────────────────────
// Fetches data from the Node.js API server with error handling

const API_BASE = '';

async function safeFetch(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[DataService] ${url} failed:`, err.message);
    return null;
  }
}

const DataService = {
  async getCities() {
    return (await safeFetch(`${API_BASE}/api/cities`)) || [];
  },

  async getStops(city) {
    const url = city ? `${API_BASE}/api/stops?city=${city}` : `${API_BASE}/api/stops`;
    return (await safeFetch(url)) || [];
  },

  async getStop(id) {
    return await safeFetch(`${API_BASE}/api/stops/${id}`);
  },

  async getArrivals(stopId) {
    return (await safeFetch(`${API_BASE}/api/stops/${stopId}/arrivals`)) || [];
  },

  async getCrowd(stopId) {
    return await safeFetch(`${API_BASE}/api/stops/${stopId}/crowd`);
  },

  async getAdvice(stopId) {
    return await safeFetch(`${API_BASE}/api/stops/${stopId}/advice`);
  },

  async getHackathonStats() {
    return await safeFetch(`${API_BASE}/api/hackathon/stats`);
  },

  async getJourney(fromId, toId) {
    return await safeFetch(`${API_BASE}/api/journey?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}`);
  },

  async getRoutes(city) {
    const url = city ? `${API_BASE}/api/routes?city=${city}` : `${API_BASE}/api/routes`;
    return (await safeFetch(url)) || [];
  },

  async getWeather(city) {
    return await safeFetch(`${API_BASE}/api/weather?city=${city || 'Istanbul'}`);
  },
};
