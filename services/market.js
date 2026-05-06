const POLYGON_KEY = process.env.POLYGON_API_KEY;
const BASE_URL = "https://api.polygon.io";

if (!POLYGON_KEY) {
  console.warn("⚠️ POLYGON_API_KEY no definida en variables de entorno");
}

/* =========================
   MAPEO DE SÍMBOLOS (FIX CLAVE)
========================= */
const SYMBOL_MAP = {
  GOLD: "XAUUSD",
  SILVER: "XAGUSD",
  OIL: "CL.1",
  BTC: "X:BTCUSD",
  ETH: "X:ETHUSD",
  EURUSD: "C:EURUSD",
  USDJPY: "C:USDJPY"
};

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
   NORMALIZAR SYMBOL (FIXED)
========================= */
export function normalizeSymbol(symbol) {
  let s = String(symbol || "")
    .trim()
    .toUpperCase()
    .replace("TVC:", "")
    .replace("OANDA:", "")
    .replace("/", "")
    .replace("-", "")
    .replace("_", "");

  // 🔥 MAPEO INTELIGENTE
  if (SYMBOL_MAP[s]) {
    s = SYMBOL_MAP[s];
  }

  return s;
}

/* =========================
   OBTENER PRECIO ACTUAL (FIX REAL)
========================= */
export async function getPrice(symbol) {
  symbol = normalizeSymbol(symbol);

  const cached = getCache(symbol);
  if (cached) return cached;

  try {
    // 🔥 intentamos varios formatos compatibles con Polygon
    const candidates = [
      symbol,
      `C:${symbol}`,
      `X:${symbol}`,
      `O:${symbol}`
    ];

    let data = null;

    for (const sym of candidates) {
      const url = `${BASE_URL}/v2/last/trade/${sym}?apiKey=${POLYGON_KEY}`;

      try {
        const res = await fetch(url);
        const json = await res.json();

        if (json?.results?.p) {
          data = json;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    // ❌ si no hay data válida
    if (!data || !data.results || typeof data.results.p !== "number") {
      return {
        symbol,
        price: null,
        source: "polygon_fail",
        error: true,
        time: Date.now()
      };
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
      price: null,
      source: "error",
      error: true,
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
      const price = await getPrice(s);
      results.push(price);
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

  // 🔥 SEGURIDAD REAL
  if (!market || market.price === null) {
    throw new Error(`No se pudo obtener precio de mercado para ${symbol}`);
  }

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
