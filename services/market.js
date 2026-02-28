// services/market.js
// Usa fetch nativo (Node >= 18). Asegúrate que en Render estés usando Node >= 18.
const POLYGON_KEY = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY || "";
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
/**
 * Normaliza símbolos recibidos en varias formas
 * - Quita prefix de exchange: "BINANCE:BTCUSDT" -> "BTCUSDT"
 * - Convierte "EUR/USD", "EUR_USD" -> "EURUSD"
 * - Elimina '-' y espacios
 * - Uppercase
 */
export function normalizeSymbol(raw) {
  if (!raw) return "";
  let s = String(raw).trim();

  // si viene con exchange "EXCHANGE:SYMBOL", quitar exchange (pero conservar I: / O: si needed)
  if (s.includes(":") && !s.startsWith("I:") && !s.startsWith("O:")) {
    s = s.split(":").pop();
  }

  // limpiar separadores y caracteres no alfanuméricos permitidos
  s = s.replace(/[_\-\s\/]/g, "").toUpperCase();

  return s;
}

/* =========================
   OBTENER PRECIO ACTUAL
   ========================= */
export async function getPrice(symbol) {
  // normalizar para cache/URL
  const normalized = normalizeSymbol(symbol);
  if (!normalized) {
    return { symbol, price: null, source: "invalid", time: Date.now() };
  }

  const cached = getCache(normalized);
  if (cached) return cached;

  // asegúrate que fetch exista (Node >=18 lo tiene)
  if (typeof fetch !== "function") {
    const err = new Error("Global fetch no disponible en este runtime. Usa Node >= 18 o instala node-fetch");
    console.error(err);
    // fallback mock
    const fallback = {
      symbol: normalized,
      price: Number((Math.random() * 100 + 10).toFixed(2)),
      source: "fallback",
      time: Date.now()
    };
    setCache(normalized, fallback);
    return fallback;
  }

  try {
    // encodeURIComponent sólo sobre symbol normalizado por si acaso
    const url = `${BASE_URL}/v2/last/trade/${encodeURIComponent(normalized)}?apiKey=${encodeURIComponent(POLYGON_KEY)}`;
    const res = await fetch(url, { method: "GET" });

    // Si la respuesta no es JSON, lanzar y usar fallback
    const ct = res.headers.get("content-type") || "";
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} - ${text || res.statusText}`);
    }

    let data;
    if (ct.includes("application/json")) {
      data = await res.json();
    } else {
      // respuesta no JSON (posible página de error) -> lanzar
      const txt = await res.text().catch(() => "");
      throw new Error(`Non-JSON response: ${txt.slice(0, 200)}`);
    }

    // polygon v2 last trade shape: { results: { p: price, ... } }
    const priceValue = Number(data?.results?.p ?? data?.results?.price ?? data?.price ?? NaN);
    if (!isFinite(priceValue)) {
      throw new Error("Precio no encontrado en respuesta de Polygon");
    }

    const result = {
      symbol: normalized,
      price: priceValue,
      source: "polygon",
      time: Date.now()
    };

    setCache(normalized, result);
    return result;
  } catch (err) {
    console.error("Market price error:", err && err.message ? err.message : err);

    // fallback seguro (no rompe trading)
    const fallback = {
      symbol: normalized,
      price: Number((Math.random() * 100 + 10).toFixed(2)),
      source: "fallback",
      time: Date.now()
    };

    setCache(normalized, fallback);
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
    } catch (e) {
      results.push({
        symbol: s,
        price: null,
        error: true
      });
    }
  }

  return results;
}
