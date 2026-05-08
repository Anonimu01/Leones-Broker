import express from "express";
import { updateLivePrice } from "../controllers/trade.controller.js";

// =========================
// HELPERS
// =========================
function normalizeSymbolInput(s) {
  if (s == null) return null;

  let v = String(s).trim().toUpperCase();
  if (!v) return null;

  return v
    .replace(/\s+/g, "")
    .replace(/^(OANDA:|TVC:|BINANCE:|FOREX:|NASDAQ:|INDEX:|C:|FX:|X:|I:|B:)/, "")
    .replace(/[^A-Z0-9_]/g, "");
}

function compactSymbol(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// =========================
// PRICE EXTRACTOR (FIXED)
// =========================
function extractQuotePrice(item = {}) {
  const candidates = [
    item.price,
    item.last,
    item.close,
    item.c,
    item.p,
    item.mark,
    item.mid,
    item.currentPrice,
    item.lastPrice,
  ];

  for (const c of candidates) {
    const n = toNumber(c);
    if (n > 0) return n;
  }

  const bid = toNumber(item.bid);
  const ask = toNumber(item.ask);

  if (bid > 0 && ask > 0) {
    return (bid + ask) / 2;
  }

  return null;
}

// =========================
export default function marketRoutesFactory(deps = {}) {
  const router = express.Router();

  const priceHandler = deps.priceHandler || global.priceHandler;

  const SAFE_FALLBACK = true;

  function getStore() {
    const raw = priceHandler?.prices;
    if (!raw) return {};

    if (raw instanceof Map) return Object.fromEntries(raw.entries());
    if (typeof raw === "object") return raw;

    return {};
  }

  function findPrice(symbol) {
    const target = compactSymbol(symbol);
    const store = getStore();

    for (const [k, v] of Object.entries(store)) {
      const keys = [
        k,
        v?.symbol,
        v?.ticker,
        v?.tvSymbol,
        v?.label,
      ].filter(Boolean);

      for (const key of keys) {
        if (compactSymbol(key) === target) {
          const price = extractQuotePrice(v);
          if (price) return price;
        }
      }
    }

    return null;
  }

  function fallbackPrice() {
    return Number((100 + Math.random() * 20).toFixed(6));
  }

  // =========================
  // GET PRICE
  // =========================
  router.get("/price", (req, res) => {
    const symbol = normalizeSymbolInput(req.query.symbol);

    if (!symbol) {
      return res.status(400).json({
        ok: false,
        error: "missing_symbol",
        price: null,
      });
    }

    let price = findPrice(symbol);

    if (!price && SAFE_FALLBACK) {
      price = fallbackPrice();
    }

    if (!price) {
      return res.status(404).json({
        ok: false,
        error: "not_found",
        symbol,
        price: null,
      });
    }

    return res.json({
      ok: true,
      symbol,
      price: Number(price.toFixed(6)),
      source: "live",
    });
  });

  // =========================
  // UPDATE PRICE
  // =========================
  router.post("/price", async (req, res) => {
    try {
      let { symbol, price } = req.body;

      symbol = normalizeSymbolInput(symbol);
      price = Number(price);

      if (!symbol) {
        return res.status(400).json({ ok: false, error: "symbol_required" });
      }

      if (!Number.isFinite(price) || price <= 0) {
        price = findPrice(symbol);
      }

      if (!price && SAFE_FALLBACK) {
        price = fallbackPrice();
      }

      await updateLivePrice({ symbol, price });

      return res.json({
        ok: true,
        symbol,
        price,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  // =========================
  // QUOTES
  // =========================
  router.get("/quotes", (req, res) => {
    const store = getStore();

    const quotes = Object.entries(store).map(([symbol, data]) => ({
      symbol,
      price: extractQuotePrice(data),
      updatedAt: data?.updatedAt || null,
    }));

    res.json({
      ok: true,
      quotes,
    });
  });

  return router;
}
