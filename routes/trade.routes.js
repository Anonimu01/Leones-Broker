import express from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import { openTrade, closeTrade } from "../controllers/trade.controller.js";

const router = express.Router();

const idempotencyCache = new Map();
const openOrderLocks = new Map();

// =========================
// 🔥 HELPERS PRECIO REAL
// =========================
function compactSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function getPriceStore() {
  try {
    const raw = global.priceHandler?.prices;
    if (!raw) return {};
    if (raw instanceof Map) return Object.fromEntries(raw.entries());
    return raw;
  } catch {
    return {};
  }
}

function extractPrice(item = {}) {
  return (
    Number(item.price) ||
    Number(item.last) ||
    Number(item.close) ||
    Number(item.bid) ||
    Number(item.ask) ||
    null
  );
}

function findLivePrice(symbol) {
  const store = getPriceStore();
  const target = compactSymbol(symbol);

  for (const [key, val] of Object.entries(store)) {
    const candidates = [
      key,
      val?.symbol,
      val?.ticker,
      val?.tvSymbol,
      val?.instrument,
    ];

    const match = candidates.some((c) =>
      compactSymbol(c).includes(target)
    );

    if (match) {
      const price = extractPrice(val);
      if (price && price > 0) return price;
    }
  }

  return null;
}

// =========================
// 🔧 NORMALIZACIÓN
// =========================
function cleanSymbolInput(value) {
  if (!value) return "";
  return String(value)
    .replace(/^OANDA:/i, "")
    .replace(/^OANDA/i, "")
    .replace(/\s+/g, "")
    .trim()
    .toUpperCase();
}

function extractSymbol(body = {}) {
  const rawSymbol =
    body.symbol ||
    body.tvSymbol ||
    body.chartSymbol ||
    body.instrument ||
    body.ticker ||
    "";

  return {
    rawSymbol: String(rawSymbol).trim(),
    symbol: cleanSymbolInput(rawSymbol),
    tvSymbol: cleanSymbolInput(body.tvSymbol || rawSymbol),
    chartSymbol: cleanSymbolInput(body.chartSymbol || rawSymbol),
  };
}

function validateOrderBody(body) {
  if (!body || typeof body !== "object") return "body must be an object";

  const { symbol, side, type, quantity } = body;

  if (!symbol) return "symbol required";
  if (!["buy", "sell"].includes(String(side).toLowerCase())) return "invalid side";
  if (!["market", "limit"].includes(String(type).toLowerCase())) return "invalid type";

  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) return "invalid quantity";

  return null;
}

function normalizeOrderBody(body = {}) {
  const symbolInfo = extractSymbol(body);

  return {
    ...symbolInfo,
    side: String(body.side || "buy").toLowerCase(),
    type: String(body.type || "market").toLowerCase(),
    quantity: Number(body.quantity ?? body.qty ?? body.amount),
    price: Number(body.price ?? body.entryPrice),
  };
}

// =========================
// 🔒 LOCK
// =========================
function withOpenLock(key, ttlMs = 1500) {
  const now = Date.now();
  const until = openOrderLocks.get(key) || 0;
  if (until > now) return false;

  openOrderLocks.set(key, now + ttlMs);

  setTimeout(() => openOrderLocks.delete(key), ttlMs);
  return true;
}

function releaseOpenLock(key) {
  openOrderLocks.delete(key);
}

// =========================
// 🚀 OPEN
// =========================
router.post("/open", authMiddleware, async (req, res) => {
  let lockKey = null;

  try {
    const user = req.user;
    const normalized = normalizeOrderBody(req.body);

    const error = validateOrderBody(normalized);
    if (error) return res.status(400).json({ ok: false, error });

    lockKey = `${user._id}:${normalized.symbol}`;
    if (!withOpenLock(lockKey)) {
      return res.status(429).json({ ok: false, error: "duplicate_order_blocked" });
    }

    const result = await openTrade({
      user,
      order: {
        symbol: normalized.symbol,
        side: normalized.side.toUpperCase(),
        type: normalized.type.toUpperCase(),
        quantity: normalized.quantity,
        price: normalized.price || findLivePrice(normalized.symbol),
      },
    });

    return res.json({ ok: true, data: result.data });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  } finally {
    if (lockKey) releaseOpenLock(lockKey);
  }
});

// =========================
// 🔥 CLOSE (AQUI ESTA LO CLAVE)
// =========================
router.post("/close", authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const body = req.body || {};

    const positionId = String(body.positionId || "").trim();

    if (!positionId) {
      return res.status(400).json({ ok: false, error: "positionId_required" });
    }

    // 🔥 SI NO VIENE PRECIO → LO BUSCA SOLO
    let closePrice = Number(body.price);

    if (!Number.isFinite(closePrice) || closePrice <= 0) {
      closePrice = findLivePrice(body.symbol);
    }

    if (!closePrice || closePrice <= 0) {
      return res.status(400).json({
        ok: false,
        error: "no_live_price_available",
      });
    }

    const result = await closeTrade({
      user,
      positionId,
      closePrice,
    });

    return res.json({
      ok: true,
      msg: "Operación cerrada",
      data: result.data,
    });

  } catch (err) {
    console.error("close error:", err);
    res.status(500).json({ ok: false });
  }
});

// =========================
router.get("/health", (req, res) => {
  res.json({ ok: true });
});

export default router;
