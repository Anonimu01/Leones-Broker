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

    const price = Number(data?.results?.p);

    // 🔥 VALIDACIÓN ESTRICTA (IMPORTANTE)
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error("Precio inválido desde API");
    }

    const result = {
      symbol,
      price,
      source: "polygon",
      time: Date.now()
    };

    setCache(symbol, result);
    return result;

  } catch (err) {
    console.error("❌ Market price error:", err.message);

    // 🚨 IMPORTANTE: NO usar precio falso
    return null;
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

      results.push(
        p || {
          symbol: s,
          price: null,
          error: true
        }
      );
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

  // 🔥 BLOQUEO SI NO HAY PRECIO REAL
  if (!market || !market.price) {
    throw new Error("No hay precio de mercado disponible");
  }

  const executionPrice =
    type === "market"
      ? market.price
      : Number(price || market.price);

  const execPrice = Number(executionPrice);

  return {
    id: "ord_" + Math.random().toString(36).slice(2),
    userId,
    symbol: normalizeSymbol(symbol),
    side: side.toLowerCase(),
    type,
    quantity: Number(quantity),
    requestedPrice: price,
    executedPrice: execPrice,
    status: "filled",
    liquidity: "market",

    // 🔥 EVITAR NaN
    slippage: Number.isFinite(execPrice - market.price)
      ? Number((execPrice - market.price).toFixed(5))
      : 0,

    source: market.source,
    createdAt: new Date().toISOString()
  };
}
