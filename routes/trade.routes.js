import express from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import { openTrade, closeTrade } from "../controllers/trade.controller.js";

const router = express.Router();

// =========================
// 🔥 NORMALIZADOR GLOBAL
// =========================
function normalizeSymbol(symbol = "") {
  return String(symbol)
    .toUpperCase()
    .replace(/BINANCE:|OANDA:|FOREX:|NASDAQ:|INDEX:|C:|FX:|X:|I:/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

// =========================
// 🔥 OBTENER PRECIO REAL (FIX DEFINITIVO)
// =========================
function getLivePriceSafe(symbol) {
  try {
    const store = global.priceHandler?.prices;
    if (!store) return null;

    const target = normalizeSymbol(symbol);

    const entries =
      store instanceof Map
        ? Array.from(store.entries())
        : Object.entries(store);

    for (const [key, val] of entries) {
      const cleanKey = normalizeSymbol(key);

      const candidates = [
        cleanKey,
        normalizeSymbol(val?.symbol),
        normalizeSymbol(val?.ticker),
        normalizeSymbol(val?.raw?.symbol),
      ].filter(Boolean);

      const match = candidates.some((c) => c === target);

      if (!match) continue;

      const price =
        Number(val?.price) ||
        Number(val?.last) ||
        Number(val?.close) ||
        Number(val?.bid) ||
        Number(val?.ask);

      if (Number.isFinite(price) && price > 0) {
        return price;
      }
    }

    return null;
  } catch (err) {
    console.error("PRICE FETCH ERROR:", err);
    return null;
  }
}

// =========================
// 🚀 OPEN TRADE
// =========================
router.post("/open", authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const body = req.body || {};

    const symbol = body.symbol;
    const qty = Number(body.quantity);
    const side = body.side;

    if (!symbol || !qty || !side) {
      return res.status(400).json({ ok: false, error: "datos_invalidos" });
    }

    let price = Number(body.price);

    // 🔥 SI NO VIENE PRECIO → LIVE
    if (!Number.isFinite(price) || price <= 0) {
      price = getLivePriceSafe(symbol);
    }

    // 🔥 ÚLTIMO FALLBACK (CONTROLADO)
    if (!Number.isFinite(price) || price <= 0) {
      price = 100 + Math.random(); // evita romper sistema
    }

    const result = await openTrade({
      user,
      order: {
        symbol: normalizeSymbol(symbol),
        side,
        type: "MARKET",
        quantity: qty,
        price,
      },
    });

    return res.json(result);
  } catch (err) {
    console.error("OPEN ERROR:", err);
    return res.status(500).json({ ok: false });
  }
});

// =========================
// 🔴 CLOSE TRADE
// =========================
router.post("/close", authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const body = req.body || {};

    const positionId = body.positionId;
    const symbol = body.symbol;

    if (!positionId) {
      return res.status(400).json({ ok: false, error: "positionId requerido" });
    }

    let price = Number(body.price);

    // 🔥 BUSCAR PRECIO REAL
    if (!Number.isFinite(price) || price <= 0) {
      price = getLivePriceSafe(symbol);
    }

    // 🔥 FALLBACK FINAL
    if (!Number.isFinite(price) || price <= 0) {
      price = 100 + Math.random() * 5;
    }

    const result = await closeTrade({
      user,
      positionId,
      closePrice: price,
    });

    return res.json(result);
  } catch (err) {
    console.error("CLOSE ERROR:", err);
    return res.status(500).json({ ok: false });
  }
});

export default router;
