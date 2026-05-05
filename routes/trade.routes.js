import express from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import { openTrade, closeTrade } from "../controllers/trade.controller.js";

const router = express.Router();

const idempotencyCache = new Map();
const openOrderLocks = new Map();

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
    body.selectedSymbol ||
    body.chartSymbol ||
    body.instrument ||
    body.marketSymbol ||
    body.market ||
    body.ticker ||
    body.asset ||
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

  const { symbol, side, type, quantity, price } = body;

  if (!symbol || typeof symbol !== "string") return "symbol required";
  if (!["buy", "sell"].includes(String(side).toLowerCase())) return "invalid side";
  if (!["market", "limit"].includes(String(type).toLowerCase())) return "invalid type";

  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) return "invalid quantity";

  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return "invalid price";

  return null;
}

function normalizeOrderBody(body = {}) {
  const symbolInfo = extractSymbol(body);

  const side = String(body.side || body.direction || body.positionSide || "buy")
    .trim()
    .toLowerCase();

  const type = String(body.type || body.orderType || "market")
    .trim()
    .toLowerCase();

  const quantityRaw =
    body.quantity ??
    body.qty ??
    body.amount ??
    body.positionSize ??
    body.notional ??
    body.size ??
    body.volume ??
    body.lots ??
    body.contracts ??
    body.units ??
    body.lotSize;

  const priceRaw =
    body.price ??
    body.entryPrice ??
    body.entry_price ??
    body.currentPrice ??
    body.current_price ??
    body.lastPrice ??
    body.last_price ??
    body.marketPrice ??
    body.market_price ??
    body.quotePrice ??
    body.quote_price ??
    body.executionPrice ??
    body.execution_price ??
    body.ask ??
    body.bid ??
    body.mark;

  return {
    ...symbolInfo,
    side,
    type,
    quantity: Number(quantityRaw),
    price: Number(priceRaw),
  };
}

function withOpenLock(key, ttlMs = 1500) {
  const now = Date.now();
  const until = openOrderLocks.get(key) || 0;
  if (until > now) return false;

  openOrderLocks.set(key, now + ttlMs);

  const t = setTimeout(() => {
    const current = openOrderLocks.get(key) || 0;
    if (current <= Date.now()) openOrderLocks.delete(key);
  }, ttlMs + 100);

  if (t && typeof t.unref === "function") t.unref();
  return true;
}

function releaseOpenLock(key) {
  openOrderLocks.delete(key);
}

router.post("/open", authMiddleware, async (req, res) => {
  let lockKey = null;

  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const body = req.body || {};
    const normalized = normalizeOrderBody(body);

    const error = validateOrderBody(normalized);
    if (error) {
      return res.status(400).json({ ok: false, error });
    }

    const idemKey = req.headers["idempotency-key"] || body.clientOrderId || body.orderId || body.clientOrderID;

    if (idemKey) {
      const key = `${user._id}::${idemKey}`;
      if (idempotencyCache.has(key)) {
        const cached = idempotencyCache.get(key);
        return res.json({
          ok: true,
          data: cached,
          idempotent: true,
        });
      }
    }

    lockKey = `${user._id}:${normalized.symbol}:${normalized.side}:${normalized.quantity}:${normalized.price}`;
    if (!withOpenLock(lockKey, 2500)) {
      return res.status(429).json({ ok: false, error: "duplicate_order_blocked" });
    }

    const order = {
      symbol: normalized.symbol,
      tvSymbol: normalized.tvSymbol,
      chartSymbol: normalized.chartSymbol,
      rawSymbol: normalized.rawSymbol,
      side: normalized.side.toUpperCase(),
      type: normalized.type.toUpperCase(),
      quantity: Number(normalized.quantity),
      price: Number.isFinite(normalized.price) && normalized.price > 0 ? Number(normalized.price) : null,
    };

    console.log("🚀 ORDER BACKEND:", order);

    let result;
    for (let i = 0; i < 3; i++) {
      try {
        result = await openTrade({ user, order });
        break;
      } catch (err) {
        if (err?.message?.includes("Write conflict")) {
          console.warn(`⚠️ Write conflict, retry ${i + 1}`);
          await new Promise((r) => setTimeout(r, 120));
        } else {
          throw err;
        }
      }
    }

    if (!result || !result.ok) {
      return res.status(400).json({
        ok: false,
        error: result?.error || "Trade failed",
      });
    }

    const responseData = {
      ...(result.data || {}),
      symbol: normalized.symbol,
      tvSymbol: normalized.tvSymbol || normalized.symbol,
      chartSymbol: normalized.chartSymbol || normalized.symbol,
      rawSymbol: normalized.rawSymbol || normalized.symbol,
      displaySymbol: normalized.tvSymbol || normalized.chartSymbol || normalized.symbol,
    };

    if (idemKey) {
      const key = `${user._id}::${idemKey}`;
      idempotencyCache.set(key, responseData);
    }

    return res.json({
      ok: true,
      msg: "Operación abierta",
      data: responseData,
    });
  } catch (err) {
    console.error("Trade open error:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "server_error",
    });
  } finally {
    if (lockKey) releaseOpenLock(lockKey);
  }
});

router.post("/close", authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const body = req.body || {};
    const positionId = String(body.positionId || body.id || body.position || "").trim();

    const closePriceRaw =
      body.price ??
      body.closePrice ??
      body.currentPrice ??
      body.current_price ??
      body.exitPrice ??
      body.exit_price ??
      body.mark;

    const closePrice = Number(closePriceRaw);

    if (!positionId) {
      return res.status(400).json({ ok: false, error: "positionId_required" });
    }

    if (!Number.isFinite(closePrice) || closePrice <= 0) {
      return res.status(400).json({ ok: false, error: "price_invalid" });
    }

    const result = await closeTrade({
      user,
      positionId,
      closePrice,
    });

    if (!result || !result.ok) {
      return res.status(400).json({
        ok: false,
        error: result?.error || "Close trade failed",
      });
    }

    return res.json({
      ok: true,
      msg: "Operación cerrada",
      data: result.data,
    });
  } catch (err) {
    console.error("Trade close error:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "server_error",
    });
  }
});

router.get("/health", (req, res) => {
  res.json({ ok: true, module: "trade.routes" });
});

export default router;
