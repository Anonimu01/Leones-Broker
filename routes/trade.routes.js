// routes/trade.routes.js
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
    if (!user) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const body = req.body;

    const error = validateOrderBody(body);
    if (error) {
      return res.status(400).json({ ok: false, error });
    }

    const { symbol, side, type, quantity, price } = body;

    const idemKey = req.headers["idempotency-key"] || body.clientOrderId;

    // 🔁 IDEMPOTENCIA
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
      symbol: String(symbol).toUpperCase(),
      side: String(side).toUpperCase(),
      type: String(type).toUpperCase(),
      quantity: Number(quantity),
      price: price ? Number(price) : null
    };

    console.log("🚀 ORDER BACKEND:", order);

    let result;

    // 🔥 RETRY AUTOMÁTICO PARA WRITE CONFLICT
    for (let i = 0; i < 3; i++) {
      try {
        result = await openTrade({ user, order });
        break;
      } catch (err) {
        if (err.message?.includes("Write conflict")) {
          console.warn(`⚠️ Write conflict, retry ${i + 1}`);
          await new Promise(r => setTimeout(r, 120));
        } else {
          throw err;
        }
      }
    }

    if (!result || !result.ok) {
      return res.status(400).json({
        ok: false,
        error: result?.error || "Trade failed"
      });
    }

    // 💾 GUARDAR EN CACHE IDEMPOTENTE
    if (idemKey) {
      const key = `${user._id}::${idemKey}`;
      idempotencyCache.set(key, result.data);
    }

    return res.json({
      ok: true,
      msg: "Operación abierta",
      data: result.data
    });

  } catch (err) {
    console.error("Trade error:", err);

    return res.status(500).json({
      ok: false,
      error: err.message || "server_error"
    });
  }
});

export default router;
