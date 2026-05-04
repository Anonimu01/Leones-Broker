import express from "express";
// import { authMiddleware } from "../middlewares/auth.middleware.js";

// 🔥 IMPORTANTE: conectar con trading
import { updateLivePrice } from "../controllers/trade.controller.js";

function normalizeSymbolInput(s) {
  if (!s) return null;
  return String(s).trim().toUpperCase();
}

export default function marketRoutesFactory(deps = {}) {
  const router = express.Router();
  const polygonSocket = deps.polygonSocket;

  // router.use(authMiddleware);

  // =========================
  // 📡 SUBSCRIBE
  // =========================
  router.post("/subscribe", (req, res) => {
    if (!polygonSocket) {
      return res.status(503).json({ ok: false, msg: "Realtime socket not initialized" });
    }

    let { symbol, kind } = req.body || {};
    kind = (kind || "trades").toString();

    if (!symbol) {
      return res.status(400).json({ ok: false, msg: "symbol required" });
    }

    const symbols = Array.isArray(symbol)
      ? symbol.map(normalizeSymbolInput).filter(Boolean)
      : [normalizeSymbolInput(symbol)];

    try {
      symbols.forEach((s) => polygonSocket.subscribe(s, kind));

      return res.json({
        ok: true,
        subscribed: symbols,
        kind,
      });
    } catch (e) {
      console.error("market.subscribe error:", e);
      return res.status(500).json({ ok: false, msg: String(e) });
    }
  });

  // =========================
  // ❌ UNSUBSCRIBE
  // =========================
  router.post("/unsubscribe", (req, res) => {
    if (!polygonSocket) {
      return res.status(503).json({ ok: false, msg: "Realtime socket not initialized" });
    }

    let { symbol, kind } = req.body || {};
    kind = (kind || "trades").toString();

    if (!symbol) {
      return res.status(400).json({ ok: false, msg: "symbol required" });
    }

    const symbols = Array.isArray(symbol)
      ? symbol.map(normalizeSymbolInput).filter(Boolean)
      : [normalizeSymbolInput(symbol)];

    try {
      symbols.forEach((s) => polygonSocket.unsubscribe(s, kind));

      return res.json({
        ok: true,
        unsubscribed: symbols,
        kind,
      });
    } catch (e) {
      console.error("market.unsubscribe error:", e);
      return res.status(500).json({ ok: false, msg: String(e) });
    }
  });

  // =========================
  // 📊 SUBSCRIPTIONS
  // =========================
  router.get("/subscriptions", (req, res) => {
    if (!polygonSocket) {
      return res.status(503).json({ ok: false, msg: "Realtime socket not initialized" });
    }

    try {
      const list = polygonSocket.listSubscriptions();
      res.json({ ok: true, list });
    } catch (e) {
      console.error("market.subscriptions error:", e);
      res.status(500).json({ ok: false, msg: String(e) });
    }
  });

  // =========================
  // 🔥 NUEVO: RECIBIR PRECIO Y ACTUALIZAR PNL
  // =========================
  router.post("/price", async (req, res) => {
    try {
      let { symbol, price } = req.body || {};

      symbol = normalizeSymbolInput(symbol);
      price = Number(price);

      if (!symbol || !Number.isFinite(price) || price <= 0) {
        return res.status(400).json({
          ok: false,
          msg: "symbol y price válidos requeridos",
        });
      }

      // 🔥 ACTUALIZA TODAS LAS POSICIONES ABIERTAS
      await updateLivePrice({ symbol, price });

      return res.json({
        ok: true,
        symbol,
        price,
        msg: "Precio actualizado y PnL recalculado",
      });
    } catch (err) {
      console.error("market.price error:", err);
      return res.status(500).json({
        ok: false,
        msg: err.message || "error",
      });
    }
  });

  return router;
}
