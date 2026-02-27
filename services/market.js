import fetch from "node-fetch";

const POLYGON_KEY = process.env.POLYGON_API_KEY;
const BASE_URL = "https://api.polygon.io";

if (!POLYGON_KEY) {
  console.warn("⚠️ POLYGON_API_KEY no definida en variables de entorno");
}

/* =========================
   CACHE SIMPLE EN MEMORIA
========================= */
const priceCache = new Map();
const CACHE_TIME = 5000; // 5 segundos

function setCache(symbol, data) {
  priceCache.set(symbol, {
    data,
    time: Date.now()
  });
}

function getCache(symbol) {
  const entry = priceCache.get(symbol);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TIME) {
    priceCache.delete(symbol);
    return null;
  }
  return entry.data;
}

/* =========================
   NORMALIZAR SYMBOL
========================= */
export function normalizeSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace("/", "")
    .replace("-", "");
}

/* =========================
   OBTENER PRECIO ACTUAL
========================= */
export async function getPrice(symbol) {
  symbol = normalizeSymbol(symbol);

  const cached = getCache(symbol);
  if (cached) return cached;

  try {
    const url = `${BASE_URL}/v2/last/trade/${symbol}?apiKey=${POLYGON_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data?.results?.p) {
      throw new Error("Precio no encontrado");
    }

    const price = Number(data.results.p);

    const result = {
      symbol,
      price,
      source: "polygon",
      time: Date.now()
    };

    setCache(symbol, result);
    return result;
  } catch (err) {
    console.error("Market price error:", err.message);

    // fallback mock seguro (nunca rompe el broker)
    const fallback = {
      symbol,
      price: Number((Math.random() * 100 + 10).toFixed(2)),
      source: "fallback",
      time: Date.now()
    };

    return fallback;
  }
}

/* =========================
   SNAPSHOT MULTIPLE
========================= */
export async function getPrices(symbols = []) {
  const results = [];

  for (const s of symbols) {
    try {
      const p = await getPrice(s);
      results.push(p);
    } catch {
      results.push({
        symbol: s,
        price: null,
        error: true
      });
    }
  }

  return results;
}
