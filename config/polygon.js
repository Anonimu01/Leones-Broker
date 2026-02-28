// config/polygon.js
// Configuración simple para la conexión con Polygon

export const key = process.env.POLYGON_API_KEY || "";

export const endpoints = {
  stocks: "wss://socket.polygon.io/stocks",
  crypto:  "wss://socket.polygon.io/crypto",
  forex:   "wss://socket.polygon.io/forex",
  indices: "wss://socket.polygon.io/indices",
  options: "wss://socket.polygon.io/options"
};

export const prefixes = {
  trades: "T.",
  quotes: "Q.",
  aggs:   "A."
};

export const availableMarkets = Object.keys(endpoints);
export default { key, endpoints, prefixes, availableMarkets };
