// ─── Data Service ───────────────────────────────────────────────────────
// Fetches data from the Node.js API server

const API_BASE = '';

const DataService = {
  async getCities() {
    const res = await fetch(`${API_BASE}/api/cities`);
    return res.json();
  },

  async getStops(city) {
    const url = city ? `${API_BASE}/api/stops?city=${city}` : `${API_BASE}/api/stops`;
    const res = await fetch(url);
    return res.json();
  },

  async getStop(id) {
    const res = await fetch(`${API_BASE}/api/stops/${id}`);
    return res.json();
  },

  async getArrivals(stopId) {
    const res = await fetch(`${API_BASE}/api/stops/${stopId}/arrivals`);
    return res.json();
  },

  async getCrowd(stopId) {
    const res = await fetch(`${API_BASE}/api/stops/${stopId}/crowd`);
    return res.json();
  },

  async getAdvice(stopId) {
    const res = await fetch(`${API_BASE}/api/stops/${stopId}/advice`);
    return res.json();
  },

  async getHackathonStats() {
    const res = await fetch(`${API_BASE}/api/hackathon/stats`);
    return res.json();
  },

  async getRoutes(city) {
    const url = city ? `${API_BASE}/api/routes?city=${city}` : `${API_BASE}/api/routes`;
    const res = await fetch(url);
    return res.json();
  },

  async getWeather(city) {
    const res = await fetch(`${API_BASE}/api/weather?city=${city || 'Istanbul'}`);
    return res.json();
  },
};
