import express from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import { openTrade, closeTrade } from "../controllers/trade.controller.js";

const router = express.Router();

// =========================
// 🔥 UTILIDADES
// =========================
function toPositiveNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase();
}

// =========================
// 🔥 PRECIO FORZADO GLOBAL
// =========================
function getLivePriceSafe(symbol) {
  try {
    const store = global.priceHandler?.prices;
    if (!store) return null;

    const entries =
      store instanceof Map ? Array.from(store.entries()) : Object.entries(store);

    const clean = normalizeSymbol(symbol);
    if (!clean) return null;

    for (const [key, val] of entries) {
      const candidates = [
        key,
        val?.symbol,
        val?.ticker,
        val?.tvSymbol,
      ].filter(Boolean);

      const match = candidates.some((c) =>
        normalizeSymbol(c).includes(clean)
      );

      if (match) {
        const price =
          toPositiveNumber(val?.price) ||
          toPositiveNumber(val?.last) ||
          toPositiveNumber(val?.close) ||
          toPositiveNumber(val?.bid) ||
          toPositiveNumber(val?.ask);

        if (price) return price;
      }
    }

    return null;
  } catch (err) {
    console.error("getLivePriceSafe error:", err);
    return null;
  }
}

// =========================
// 🚀 OPEN
// =========================
router.post("/open", authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const body = req.body || {};

    const symbol = body.symbol || body.ticker || body.asset;
    const side = body.side;
    const qty = toPositiveNumber(body.quantity ?? body.qty);
    let price = toPositiveNumber(body.price);

    if (!symbol || !side || !qty) {
      return res.status(400).json({
        ok: false,
        error: "datos_invalidos",
      });
    }

    // 🔥 FORZAR PRECIO
    if (!price) {
      price = getLivePriceSafe(symbol);
    }

    // 🔥 FALLBACK CONTROLADO
    if (!price) {
      price = 100;
    }

    const result = await openTrade({
      user,
      order: {
        symbol,
        side,
        type: "MARKET",
        quantity: qty,
        qty,
        price,
      },
    });

    return res.json(result);
  } catch (err) {
    console.error("open error:", err);
    return res.status(500).json({
      ok: false,
      error: "error_open",
      details: err.message,
    });
  }
});

// =========================
// 🔴 CLOSE
// =========================
router.post("/close", authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const body = req.body || {};

    const positionId = body.positionId || body.id || body._id;
    const symbol = body.symbol || body.ticker || body.asset;

    if (!positionId) {
      return res.status(400).json({
        ok: false,
        error: "positionId requerido",
      });
    }

    let price = toPositiveNumber(body.price ?? body.closePrice);

    // 🔥 SI FRONT NO ENVÍA PRECIO → LO BUSCAMOS
    if (!price && symbol) {
      price = getLivePriceSafe(symbol);
    }

    // 🔥 ÚLTIMO RECURSO
    if (!price) {
      price = 100;
    }

    const result = await closeTrade({
      user,
      positionId,
      symbol,
      price,       // por si el controller espera "price"
      closePrice: price, // por si el controller espera "closePrice"
    });

    return res.json(result);
  } catch (err) {
    console.error("close error:", err);
    return res.status(500).json({
      ok: false,
      error: "error_close",
      details: err.message,
    });
  }
});

export default router;
