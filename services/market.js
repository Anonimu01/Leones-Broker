const POLYGON_KEY = process.env.POLYGON_API_KEY;
const BASE_URL = "https://api.polygon.io";

if (!POLYGON_KEY) {
  console.warn("⚠️ POLYGON_API_KEY no definida en variables de entorno");
}

/* =========================
   CACHE SIMPLE EN MEMORIA
========================= */
const priceCache = new Map();
const CACHE_TIME = 5000;

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
    .replace("-", "")
    .replace("_", "");
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

    return {
      symbol,
      price: Number((Math.random() * 100 + 10).toFixed(2)),
      source: "fallback",
      time: Date.now()
    };
  }
}

/* =========================
   SNAPSHOT MULTIPLE
========================= */
export async function getPrices(symbols = []) {
  const results = [];

  for (const s of symbols) {
    try {
      results.push(await getPrice(s));
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

/* =========================
   EJECUTAR ORDEN (BROKER ENGINE)
========================= */
export async function executeOrderOnBroker({
  symbol,
  side,
  quantity,
  type = "market",
  price = null,
  userId = null
}) {
  if (!symbol || !side || !quantity) {
    throw new Error("Datos incompletos para ejecutar orden");
  }

  const market = await getPrice(symbol);

  const executionPrice =
    type === "market"
      ? market.price
      : Number(price || market.price);

  return {
    id: "ord_" + Math.random().toString(36).slice(2),
    userId,
    symbol: normalizeSymbol(symbol),
    side: side.toLowerCase(),
    type,
    quantity: Number(quantity),
    requestedPrice: price,
    executedPrice: executionPrice,
    status: "filled",
    liquidity: "market",
    slippage: Number((executionPrice - market.price).toFixed(5)),
    source: market.source,
    createdAt: new Date().toISOString()
  };
}
