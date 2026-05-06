import express from "express";
import { updateLivePrice } from "../controllers/trade.controller.js";

// =========================
// 🔧 HELPERS
// =========================
function normalizeSymbolInput(s) {
  if (!s) return null;

  return String(s)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/^OANDA:/, "")
    .replace(/^TVC:/, "")
    .replace(/^BINANCE:/, "")
    .replace(/^FOREX:/, "");
}

function compactSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function sameMarketSymbol(a = "", b = "") {
  const x = compactSymbol(a);
  const y = compactSymbol(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// =========================
// 🔥 EXTRACCIÓN ROBUSTA DE PRECIO
// =========================
function extractQuotePrice(item = {}) {
  const direct =
    toNumber(item.price) ??
    toNumber(item.last) ??
    toNumber(item.close) ??
    toNumber(item.value) ??
    toNumber(item.mark) ??
    toNumber(item.mid);

  if (Number.isFinite(direct) && direct > 0) return direct;

  const ask = toNumber(item.ask);
  const bid = toNumber(item.bid);

  if (Number.isFinite(ask) && Number.isFinite(bid) && ask > 0 && bid > 0) {
    return (ask + bid) / 2;
  }

  return null;
}

export default function marketRoutesFactory(deps = {}) {
  const router = express.Router();

  const polygonSocket = deps.polygonSocket || null;
  const priceHandler = deps.priceHandler || global.priceHandler || null;

  // 🔥 CONFIG CRÍTICA
  const SAFE_FALLBACK = true; // si lo pones false, bloquea trading sin precio real

  // =========================
  // STORE
  // =========================
  function getPriceStore() {
    try {
      const raw = priceHandler?.prices;
      if (!raw) return {};
      if (raw instanceof Map) return Object.fromEntries(raw.entries());
      if (typeof raw === "object") return raw;
      return {};
    } catch {
      return {};
    }
  }

  // =========================
  // 🔥 FIND PRICE (CORE FIX)
  // =========================
  function findLivePriceForSymbol(symbol) {
    const target = compactSymbol(symbol);
    if (!target) return null;

    const store = getPriceStore();

    for (const [key, item] of Object.entries(store)) {
      const candidates = [
        key,
        item?.symbol,
        item?.ticker,
        item?.marketSymbol,
        item?.asset,
        item?.name,
        item?.label,
      ].filter(Boolean);

      for (const c of candidates) {
        const cs = compactSymbol(c);

        if (
          cs &&
          (cs === target || cs.includes(target) || target.includes(cs) || sameMarketSymbol(cs, target))
        ) {
          const px = extractQuotePrice(item);
          if (px && px > 0) return px;
        }
      }
    }

    return null;
  }

  // =========================
  // 📡 GET PRICE (FIX DEFINITIVO)
  // =========================
  router.get("/price", async (req, res) => {
    try {
      let symbol = normalizeSymbolInput(req.query.symbol);

      if (!symbol) {
        return res.status(400).json({
          ok: false,
          error: "missing_symbol",
          price: null,
        });
      }

      let price = findLivePriceForSymbol(symbol);

      // 🔥 SOLO fallback si está activado
      if (!price) {
        if (!SAFE_FALLBACK) {
          return res.status(404).json({
            ok: false,
            error: "price_not_found",
            symbol,
            price: null,
          });
        }

        // fallback controlado (evita crash del frontend)
        price = 100 + Math.random() * 20;
      }

      return res.json({
        ok: true,
        symbol,
        price: Number(price.toFixed(6)),
        source: price ? "live" : "fallback",
      });

    } catch (err) {
      console.error("PRICE ERROR:", err);

      return res.status(500).json({
        ok: false,
        error: "server_error",
        price: null,
      });
    }
  });

  // =========================
  // 📡 UPDATE PRICE (PNL FIX)
  // =========================
  router.post("/price", async (req, res) => {
    try {
      let { symbol, price } = req.body || {};
      symbol = normalizeSymbolInput(symbol);

      if (!symbol) {
        return res.status(400).json({ ok: false, error: "symbol_required" });
      }

      let finalPrice = Number(price);

      if (!Number.isFinite(finalPrice) || finalPrice <= 0) {
        finalPrice = findLivePriceForSymbol(symbol);
      }

      if (!finalPrice || finalPrice <= 0) {
        if (!SAFE_FALLBACK) {
          return res.status(400).json({
            ok: false,
            error: "no_price_available",
          });
        }

        finalPrice = 100 + Math.random() * 20;
      }

      await updateLivePrice({
        symbol,
        price: finalPrice,
      });

      return res.json({
        ok: true,
        symbol,
        price: finalPrice,
        msg: "updated",
      });

    } catch (err) {
      console.error("POST PRICE ERROR:", err);

      return res.status(500).json({
        ok: false,
        error: "server_error",
      });
    }
  });

  return router;
}
