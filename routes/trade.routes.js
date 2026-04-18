// routes/trade.js
import express from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import { openTrade } from "../controllers/trade.controller.js";

const router = express.Router();

const idempotencyCache = new Map();

function validateOrderBody(body) {
  if (!body || typeof body !== "object") return "body must be an object";

  const { symbol, side, type, quantity, price } = body;

  if (!symbol || typeof symbol !== "string") return "symbol required";
  if (!["buy", "sell"].includes(String(side).toLowerCase())) return "invalid side";
  if (!["market", "limit"].includes(String(type).toLowerCase())) return "invalid type";

  const q = Number(quantity);
  if (!isFinite(q) || q <= 0) return "invalid quantity";

  if (String(type).toLowerCase() === "limit") {
    const p = Number(price);
    if (!isFinite(p) || p <= 0) return "invalid price";
  }

  return null;
}

router.post("/open", authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const error = validateOrderBody(req.body);
    if (error) return res.status(400).json({ ok: false, error });

    const idemKey = req.headers["idempotency-key"] || req.body.clientOrderId;

    if (idemKey) {
      const key = `${user._id}::${idemKey}`;
      if (idempotencyCache.has(key)) {
        return res.json({
          ok: true,
          data: idempotencyCache.get(key),
          idempotent: true
        });
      }
    }

    const order = {
      symbol: String(req.body.symbol).toUpperCase(),
      side: String(req.body.side).toUpperCase(),
      type: String(req.body.type).toUpperCase(),
      quantity: Number(req.body.quantity),
      price: req.body.price ? Number(req.body.price) : null
    };

    // 🔥 AQUÍ SE EJECUTA TODO (LO IMPORTANTE)
    const result = await openTrade({ user, order });

    if (!result || !result.ok) {
      return res.status(400).json({
        ok: false,
        error: result?.error || "Trade failed"
      });
    }

    if (idemKey) {
      const key = `${user._id}::${idemKey}`;
      idempotencyCache.set(key, result.data);
    }

    return res.json({
      ok: true,
      data: result.data
    });

  } catch (err) {
    console.error("Trade error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

export default router;
