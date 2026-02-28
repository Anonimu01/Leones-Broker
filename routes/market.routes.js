import express from "express";
// import { authMiddleware } from "../middlewares/auth.middleware.js"; // descomenta si quieres proteger estas rutas

function normalizeSymbolInput(s) {
  if (!s) return null;
  return String(s).trim();
}

export default function marketRoutesFactory(deps = {}) {
  const router = express.Router();
  const polygonSocket = deps.polygonSocket;

  // Si quieres proteger estas rutas con autenticación:
  // router.use(authMiddleware);

  router.post("/subscribe", (req, res) => {
    if (!polygonSocket) {
      return res.status(503).json({ ok: false, msg: "Realtime socket not initialized" });
    }

    let { symbol, kind } = req.body || {};
    kind = (kind || "trades").toString();

    if (!symbol) {
      return res.status(400).json({ ok: false, msg: "symbol required (string or array)" });
    }

    // support array or single symbol
    const symbols = Array.isArray(symbol) ? symbol.map(normalizeSymbolInput).filter(Boolean) : [normalizeSymbolInput(symbol)];

    if (symbols.length === 0) return res.status(400).json({ ok: false, msg: "no valid symbols provided" });

    try {
      symbols.forEach((s) => polygonSocket.subscribe(s, kind));
      return res.json({
        ok: true,
        subscribed: symbols,
        kind,
        socketConnected: polygonSocket.isConnected ? polygonSocket.isConnected() : undefined
      });
    } catch (e) {
      console.error("market.subscribe error:", e);
      return res.status(500).json({ ok: false, msg: String(e) });
    }
  });

  router.post("/unsubscribe", (req, res) => {
    if (!polygonSocket) {
      return res.status(503).json({ ok: false, msg: "Realtime socket not initialized" });
    }

    let { symbol, kind } = req.body || {};
    kind = (kind || "trades").toString();

    if (!symbol) {
      return res.status(400).json({ ok: false, msg: "symbol required (string or array)" });
    }

    const symbols = Array.isArray(symbol) ? symbol.map(normalizeSymbolInput).filter(Boolean) : [normalizeSymbolInput(symbol)];

    if (symbols.length === 0) return res.status(400).json({ ok: false, msg: "no valid symbols provided" });

    try {
      symbols.forEach((s) => polygonSocket.unsubscribe(s, kind));
      return res.json({
        ok: true,
        unsubscribed: symbols,
        kind,
        socketConnected: polygonSocket.isConnected ? polygonSocket.isConnected() : undefined
      });
    } catch (e) {
      console.error("market.unsubscribe error:", e);
      return res.status(500).json({ ok: false, msg: String(e) });
    }
  });

  router.get("/subscriptions", (req, res) => {
    if (!polygonSocket) {
      return res.status(503).json({ ok: false, msg: "Realtime socket not initialized" });
    }

    try {
      const list = polygonSocket.listSubscriptions();
      // include connection state per class when possible
      const state = {};
      Object.keys(list).forEach((cls) => {
        state[cls] = {
          connected: polygonSocket.isConnected ? !!polygonSocket.isConnected(cls) : undefined,
          count: (list[cls] || []).length,
        };
      });
      res.json({ ok: true, list, state });
    } catch (e) {
      console.error("market.subscriptions error:", e);
      res.status(500).json({ ok: false, msg: String(e) });
    }
  });

  return router;
}
