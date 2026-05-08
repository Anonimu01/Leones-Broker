import dotenv from "dotenv";
dotenv.config();

// =======================
// 🔑 API KEY
// =======================
export const key = process.env.POLYGON_API_KEY || "";

// =======================
// 🌐 WEBSOCKET ENDPOINTS
// =======================
export const endpoints = {
  stocks: "wss://socket.polygon.io/stocks",
  crypto: "wss://socket.polygon.io/crypto",
  forex: "wss://socket.polygon.io/forex",
  indices: "wss://socket.polygon.io/indices",
  options: "wss://socket.polygon.io/options",
};

// =======================
// 📡 PREFIXES POLYGON
// =======================
export const prefixes = {
  trades: "T.",
  quotes: "Q.",
  aggs: "A.",
};

// =======================
// 🧠 MARKETS AVAILABLE
// =======================
export const availableMarkets = Object.keys(endpoints);

// =======================
// 🔥 SYMBOL NORMALIZER (CLAVE FIX)
// =======================
export function normalizePolygonSymbol(symbol = "") {
  return String(symbol)
    .toUpperCase()
    .replace(/^OANDA:/, "")
    .replace(/^BINANCE:/, "")
    .replace(/^FOREX:/, "")
    .replace(/^NASDAQ:/, "")
    .replace(/^INDEX:/, "")
    .replace(/^C\./, "") // Polygon crypto format
    .replace(/\./g, "")  // remove dots (C.OANDA.EUR_USD → OANDAEUR_USD)
    .replace(/_/g, "");  // EUR_USD → EURUSD
}

// =======================
// 🔥 MAP POLYGON → BROKER SYMBOLS
// =======================
export function mapPolygonToSymbol(polygonSymbol = "") {
  const clean = normalizePolygonSymbol(polygonSymbol);

  // Forex fixes
  if (clean.includes("EURUSD")) return "EURUSD";
  if (clean.includes("USDJPY")) return "USDJPY";

  // Crypto fixes
  if (clean.includes("BTCUSDT")) return "BTCUSDT";
  if (clean.includes("ETHUSDT")) return "ETHUSDT";

  return clean;
}

// =======================
// 📊 CHECK VALID PRICE EVENT
// =======================
export function isValidPriceEvent(data) {
  return (
    data &&
    (data.p || data.price) &&
    (data.sym || data.symbol)
  );
}

// =======================
// 🔥 EXTRACT PRICE
// =======================
export function extractPrice(data) {
  return Number(data?.p || data?.price || 0);
}

// =======================
// 📡 EXTRACT SYMBOL
// =======================
export function extractSymbol(data) {
  return mapPolygonToSymbol(data?.sym || data?.symbol || "");
}

// =======================
// DEFAULT EXPORT
// =======================
export default {
  key,
  endpoints,
  prefixes,
  availableMarkets,
  normalizePolygonSymbol,
  mapPolygonToSymbol,
  isValidPriceEvent,
  extractPrice,
  extractSymbol,
};
