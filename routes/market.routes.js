import express from "express";
import { updateLivePrice } from "../controllers/trade.controller.js";

function normalizeSymbolInput(s) {
  if (!s) return null;

  return String(s)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/^OANDA:/, "OANDA:")
    .replace(/^OANDA$/, "");
}

function compactSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function sameMarketSymbol(a = "", b = "") {
  const x = compactSymbol(a);
  const y = compactSymbol(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractQuotePrice(item = {}) {
  const direct =
    toNumber(item.price) ??
    toNumber(item.last) ??
    toNumber(item.close) ??
    toNumber(item.value) ??
    toNumber(item.mark) ??
    toNumber(item.mid);

  if (Number.isFinite(direct) && direct > 0) return direct;

  const ask = toNumber(item.ask);
  const bid = toNumber(item.bid);

  if (Number.isFinite(ask) && Number.isFinite(bid) && ask > 0 && bid > 0) {
    return (ask + bid) / 2;
  }

  return null;
}

export default function marketRoutesFactory(deps = {}) {
  const router = express.Router();
  const polygonSocket = deps.polygonSocket || null;
  const priceHandler = deps.priceHandler || global.priceHandler || null;

  function getPriceStore() {
    try {
      const raw = priceHandler?.prices;
      if (!raw) return {};
      if (raw instanceof Map) return Object.fromEntries(raw.entries());
      if (typeof raw === "object") return raw;
      return {};
    } catch {
      return {};
    }
  }

  function findLivePriceForSymbol(symbol) {
    const targetCompact = compactSymbol(symbol);
    if (!targetCompact) return null;

    const store = getPriceStore();
    const entries = Object.entries(store || {});

    for (const [key, item] of entries) {
      const candidates = [
        key,
        item?.symbol,
        item?.label,
        item?.ticker,
        item?.tvSymbol,
        item?.instrument,
        item?.marketSymbol,
        item?.asset,
        item?.name,
      ].filter(Boolean);

      const matched = candidates.some((candidate) => {
        const c = compactSymbol(candidate);
        if (!c) return false;
        return (
          c === targetCompact ||
          c.includes(targetCompact) ||
          targetCompact.includes(c) ||
          sameMarketSymbol(c, targetCompact)
        );
      });

      if (!matched) continue;

      const px = extractQuotePrice(item);
      if (Number.isFinite(px) && px > 0) return px;
    }

    return null;
  }

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
      : [normalizeSymbolInput(symbol)].filter(Boolean);

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
      : [normalizeSymbolInput(symbol)].filter(Boolean);

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
  // 🔥 GET PRECIO REAL
  // =========================
  router.get("/price", async (req, res) => {
    try {
      let { symbol } = req.query;

      symbol = normalizeSymbolInput(symbol);

      if (!symbol) {
        return res.status(400).json({ ok: false, msg: "symbol required" });
      }

      const livePrice = findLivePriceForSymbol(symbol);

      if (!livePrice) {
        return res.status(503).json({
          ok: false,
          symbol,
          msg: "No live price available for this symbol",
        });
      }

      return res.json({
        ok: true,
        symbol,
        price: Number(livePrice.toFixed(8)),
      });
    } catch (err) {
      console.error("market.getPrice error:", err);
      return res.status(500).json({ ok: false, msg: err.message || "error" });
    }
  });

  // =========================
  // 🔥 POST PRECIO (ACTUALIZA PNL)
  // =========================
  router.post("/price", async (req, res) => {
    try {
      let { symbol, price } = req.body || {};

      symbol = normalizeSymbolInput(symbol);

      if (!symbol) {
        return res.status(400).json({
          ok: false,
          msg: "symbol requerido",
        });
      }

      let finalPrice = Number(price);

      if (!Number.isFinite(finalPrice) || finalPrice <= 0) {
        finalPrice = findLivePriceForSymbol(symbol);
      }

      if (!finalPrice || !Number.isFinite(finalPrice) || finalPrice <= 0) {
        return res.status(503).json({
          ok: false,
          symbol,
          msg: "No se pudo resolver un precio válido para el símbolo",
        });
      }

      await updateLivePrice({ symbol, price: finalPrice });

      return res.json({
        ok: true,
        symbol,
        price: finalPrice,
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
