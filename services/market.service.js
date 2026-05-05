const POLYGON_KEY = process.env.POLYGON_API_KEY;
const BASE_URL = "https://api.polygon.io";

if (!POLYGON_KEY) {
  console.warn("⚠️ POLYGON_API_KEY no definida en variables de entorno");
}

/* =========================
   CACHE
========================= */
const priceCache = new Map();
const CACHE_TIME = 3000;

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
   🔥 MAPPING GLOBAL DE SIMBOLOS
========================= */
function mapSymbol(symbol) {
  const s = String(symbol || "").toUpperCase().trim();

  const map = {
    "TVC:GOLD": "XAUUSD",
    "GOLD": "XAUUSD",
    "XAU": "XAUUSD",
    "NAS100": "NDX",
    "US100": "NDX",
    "SPX500": "SPX",
    "US30": "DJI",
    "BTC": "BTCUSD",
    "BTCUSD": "BTCUSD",
    "ETH": "ETHUSD",
    "ETHUSD": "ETHUSD",
    "EURUSD": "C:EURUSD",
    "GBPUSD": "C:GBPUSD",
    "USDJPY": "C:USDJPY"
  };

  return map[s] || s.replace("/", "").replace("-", "").replace("_", "");
}

/* =========================
   NORMALIZAR SYMBOL
========================= */
export function normalizeSymbol(symbol) {
  return mapSymbol(symbol);
}

/* =========================
   PRECIO REAL
========================= */
export async function getPrice(symbol) {
  const cleanSymbol = mapSymbol(symbol);

  const cached = getCache(cleanSymbol);
  if (cached) return cached;

  try {
    const url = `${BASE_URL}/v2/last/trade/${cleanSymbol}?apiKey=${POLYGON_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    const price = Number(data?.results?.p);

    if (!Number.isFinite(price) || price <= 0) {
      throw new Error("Precio inválido desde Polygon");
    }

    const result = {
      symbol: cleanSymbol,
      price,
      source: "polygon",
      time: Date.now()
    };

    setCache(cleanSymbol, result);
    return result;

  } catch (err) {
    console.error("❌ Market price error:", cleanSymbol, err.message);

    // 🚨 NO INVENTAR PRECIO
    throw new Error(`No se pudo obtener precio para ${cleanSymbol}`);
  }
}

/* =========================
   MULTIPLE PRICES
========================= */
export async function getPrices(symbols = []) {
  const results = [];

  for (const s of symbols) {
    try {
      const price = await getPrice(s);
      results.push(price);
    } catch (err) {
      results.push({
        symbol: mapSymbol(s),
        price: null,
        error: true,
        message: err.message
      });
    }
  }

  return results;
}

/* =========================
   EJECUTAR ORDEN
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
      : Number(price);

  if (!Number.isFinite(executionPrice) || executionPrice <= 0) {
    throw new Error("Precio de ejecución inválido");
  }

  return {
    id: "ord_" + Math.random().toString(36).slice(2),
    userId,
    symbol: market.symbol,
    side: side.toLowerCase(),
    type,
    quantity: Number(quantity),

    requestedPrice: price,
    executedPrice: executionPrice,

    status: "filled",
    liquidity: "market",

    slippage: Number((executionPrice - market.price).toFixed(6)),

    source: market.source,
    createdAt: new Date().toISOString()
  };
}
