// routes/trade.js
import express from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import { openTrade, getPositions } from "../controllers/trade.controller.js";

const router = express.Router();

// 🔥 CACHE IDEMPOTENCIA (temporal)
const idempotencyCache = new Map();

/**
 * VALIDACIÓN
 */
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

/**
 * 🚀 ABRIR TRADE
 */
router.post("/open", authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const error = validateOrderBody(req.body);
    if (error) return res.status(400).json({ ok: false, error });

    const idemKeyRaw = req.headers["idempotency-key"] || req.body.clientOrderId || null;
    const idemKey = idemKeyRaw ? `${user._id}::${idemKeyRaw}` : null;

    // 🔥 IDEMPOTENCIA
    if (idemKey && idempotencyCache.has(idemKey)) {
      return res.json({
        ok: true,
        data: idempotencyCache.get(idemKey),
        idempotent: true
      });
    }

    const order = {
      symbol: String(req.body.symbol).toUpperCase(),
      side: String(req.body.side).toUpperCase(),
      type: String(req.body.type).toUpperCase(),
      quantity: Number(req.body.quantity),
      price: req.body.price ? Number(req.body.price) : null
    };

    console.log("📩 Orden recibida:", order);

    // 🔥 EJECUCIÓN REAL (CONTROLLER)
    const result = await openTrade({ user, order });

    if (!result || !result.ok) {
      return res.status(400).json({
        ok: false,
        error: result?.error || "Trade failed"
      });
    }

    // 🔥 GUARDAR RESPUESTA PARA IDEMPOTENCIA
    if (idemKey) {
      idempotencyCache.set(idemKey, result.data);
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

/**
 * 🔥 OBTENER POSICIONES (ESTO ERA LO QUE TE FALTABA)
 */
router.get("/positions", authMiddleware, getPositions);

export default router;
