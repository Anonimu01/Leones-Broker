// routes/trade.js
import express from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import { openTrade } from "../controllers/trade.controller.js";

const router = express.Router();

/**
 * Simple in-memory idempotency map for demo.
 * IMPORTANT: in production use Redis or DB keyed by user+Idempotency-Key.
 */
const idempotencyCache = new Map();

/**
 * Basic request body validator (no deps).
 * Expected body:
 * {
 *   symbol: "BTCUSDT",
 *   side: "buy" | "sell",
 *   type: "market" | "limit",
 *   quantity: number,
 *   price?: number,           // required for limit orders
 *   clientOrderId?: string    // optional, your own idempotency id
 * }
 */
function validateOrderBody(body) {
  if (!body || typeof body !== "object") return "body must be an object";
  const { symbol, side, type, quantity, price } = body;
  if (!symbol || typeof symbol !== "string") return "symbol required (string)";
  if (!["buy", "sell"].includes(String(side).toLowerCase())) return "side must be 'buy' or 'sell'";
  if (!["market", "limit"].includes(String(type).toLowerCase())) return "type must be 'market' or 'limit'";
  const q = Number(quantity);
  if (!isFinite(q) || q <= 0) return "quantity must be a positive number";
  if (String(type).toLowerCase() === "limit") {
    const p = Number(price);
    if (!isFinite(p) || p <= 0) return "price must be a positive number for limit orders";
  }
  return null;
}

/**
 * Optional simple rate limiting per user (basic).
 * For production, use express-rate-limit + Redis.
 */
const userLastRequestAt = new Map();
function basicRateLimit(userId, limitMs = 250) {
  const now = Date.now();
  const last = userLastRequestAt.get(userId) || 0;
  if (now - last < limitMs) return false;
  userLastRequestAt.set(userId, now);
  return true;
}

router.post("/open", authMiddleware, async (req, res) => {
  try {
    const user = req.user; // authMiddleware should set req.user
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    // optional basic rate limit per user
    if (!basicRateLimit(user.id || user._id || user.email, 200)) {
      return res.status(429).json({ ok: false, error: "Too many requests" });
    }

    const validationError = validateOrderBody(req.body);
    if (validationError) return res.status(400).json({ ok: false, error: validationError });

    // Idempotency: use header or body.clientOrderId
    const idemHeader = req.headers["idempotency-key"] || req.body.clientOrderId || null;
    const idemKey = idemHeader ? `${user.id||user._id||user.email}::${idemHeader}` : null;

    if (idemKey) {
      if (idempotencyCache.has(idemKey)) {
        // Return previous response to ensure idempotency
        return res.status(200).json({ ok: true, result: idempotencyCache.get(idemKey), idempotent: true });
      }
    }

    // Pass the validated order to controller
    // Controller signature expected: async openTrade({ user, order }) -> returns { success: true, orderId, details }
    const order = {
      symbol: String(req.body.symbol).toUpperCase(),
      side: String(req.body.side).toLowerCase(),
      type: String(req.body.type).toLowerCase(),
      quantity: Number(req.body.quantity),
      price: req.body.price ? Number(req.body.price) : undefined,
      clientOrderId: req.body.clientOrderId || null,
      meta: req.body.meta || {}
    };

    const result = await openTrade({ user, order, ctx: { ip: req.ip, headers: req.headers } });

    // Expect controller to return { ok: true, data: {...} } or { ok:false, error: '...' }
    if (!result || result.ok !== true) {
      const code = result && result.statusCode ? result.statusCode : 500;
      return res.status(code).json({ ok: false, error: (result && result.error) || "Trade execution failed" });
    }

    // store idempotency response (in memory). TTL could be implemented.
    if (idemKey) idempotencyCache.set(idemKey, result.data);

    return res.status(200).json({ ok: true, data: result.data });

  } catch (err) {
    errlog("POST /api/trade/open error", err);
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

export default router;
