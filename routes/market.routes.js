import express from "express";
import { updateLivePrice } from "../controllers/trade.controller.js";

// =========================
// 🔧 HELPERS
// =========================
function normalizeSymbolInput(s) {
  if (s === null || s === undefined) return null;

  let value = String(s).trim().toUpperCase();
  if (!value) return null;

  value = value
    .replace(/\s+/g, "")
    .replace(/^OANDA:/, "")
    .replace(/^TVC:/, "")
    .replace(/^BINANCE:/, "")
    .replace(/^FOREX:/, "")
    .replace(/^NASDAQ:/, "")
    .replace(/^INDEX:/, "")
    .replace(/^C:/, "")
    .replace(/^FX:/, "")
    .replace(/^X:/, "")
    .replace(/^I:/, "")
    .replace(/^B:/, "");

  value = value.replace(/[^A-Z0-9_]/g, "");

  return value || null;
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

// =========================
// 🔥 EXTRACCIÓN ROBUSTA DE PRECIO
// =========================
function extractQuotePrice(item = {}) {
  const direct =
    toNumber(item.price) ??
    toNumber(item.last) ??
    toNumber(item.close) ??
    toNumber(item.value) ??
    toNumber(item.mark) ??
    toNumber(item.mid) ??
    toNumber(item.currentPrice) ??
    toNumber(item.lastPrice) ??
    toNumber(item.executionPrice);

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

  const SAFE_FALLBACK = true;

  // =========================
  // STORE
  // =========================
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

  function buildSymbolAliases(symbol = "") {
    const raw = String(symbol || "").trim().toUpperCase();
    const noSpaces = raw.replace(/\s+/g, "");
    const noPrefix = noSpaces.includes(":") ? noSpaces.split(":").pop() : noSpaces;
    const noSlash = noPrefix.replace(/\//g, "");
    const noDash = noSlash.replace(/-/g, "");
    const compact = compactSymbol(noDash);

    return [...new Set([raw, noSpaces, noPrefix, noSlash, noDash, compact])]
      .filter(Boolean)
      .map((s) => String(s).trim().toUpperCase());
  }

  // =========================
  // 🔥 FIND PRICE (CORE FIX)
  // =========================
  function findLivePriceForSymbol(symbol) {
    const target = compactSymbol(symbol);
    if (!target) return null;

    const store = getPriceStore();
    const wanted = buildSymbolAliases(symbol);

    for (const [key, item] of Object.entries(store)) {
      const candidates = [
        key,
        item?.symbol,
        item?.ticker,
        item?.tvSymbol,
        item?.marketSymbol,
        item?.instrument,
        item?.asset,
        item?.name,
        item?.label,
      ].filter(Boolean);

      const matched = candidates.some((candidate) => {
        const aliases = buildSymbolAliases(candidate);
        return aliases.some((alias) =>
          wanted.some(
            (w) =>
              alias === w ||
              alias.includes(w) ||
              w.includes(alias) ||
              sameMarketSymbol(alias, target)
          )
        );
      });

      if (!matched) continue;

      const px = extractQuotePrice(item);
      if (Number.isFinite(px) && px > 0) return px;
    }

    return null;
  }

  function getFallbackPrice() {
    return Number((100 + Math.random() * 20).toFixed(6));
  }

  // =========================
  // 📡 GET PRICE (FIX DEFINITIVO)
  // =========================
  router.get("/price", async (req, res) => {
    try {
      const rawSymbol =
        req.query.symbol ||
        req.query.tvSymbol ||
        req.query.selectedSymbol ||
        req.query.ticker ||
        req.query.asset ||
        "";

      const symbol = normalizeSymbolInput(rawSymbol);

      if (!symbol) {
        return res.status(400).json({
          ok: false,
          error: "missing_symbol",
          price: null,
        });
      }

      let price = findLivePriceForSymbol(symbol);
      let source = "live";

      if (!price) {
        const store = getPriceStore();
        const variants = buildSymbolAliases(symbol);

        for (const variant of variants) {
          const found = findLivePriceForSymbol(variant);
          if (found && Number.isFinite(found) && found > 0) {
            price = found;
            source = "live";
            break;
          }

          const rawFound = Object.entries(store).find(([k, item]) => {
            const candidates = [
              k,
              item?.symbol,
              item?.ticker,
              item?.tvSymbol,
              item?.marketSymbol,
              item?.instrument,
              item?.asset,
              item?.name,
              item?.label,
            ].filter(Boolean);

            return candidates.some((candidate) => {
              const c = compactSymbol(candidate);
              const v = compactSymbol(variant);
              return (
                c &&
                v &&
                (c === v || c.includes(v) || v.includes(c) || sameMarketSymbol(c, v))
              );
            });
          });

          if (rawFound) {
            const extracted = extractQuotePrice(rawFound[1] || {});
            if (Number.isFinite(extracted) && extracted > 0) {
              price = extracted;
              source = "live";
              break;
            }
          }
        }
      }

      if (!price) {
        if (!SAFE_FALLBACK) {
          return res.status(404).json({
            ok: false,
            error: "price_not_found",
            symbol,
            price: null,
          });
        }

        price = getFallbackPrice();
        source = "fallback";
      }

      const numericPrice = Number(price);

      if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
        return res.status(500).json({
          ok: false,
          error: "price_invalid",
          symbol,
          price: null,
        });
      }

      return res.json({
        ok: true,
        symbol,
        price: Number(numericPrice.toFixed(6)),
        source,
      });
    } catch (err) {
      console.error("PRICE ERROR:", err);

      return res.status(500).json({
        ok: false,
        error: "server_error",
        price: null,
      });
    }
  });

  // =========================
  // 📡 UPDATE PRICE (PNL FIX)
  // =========================
  router.post("/price", async (req, res) => {
    try {
      let { symbol, price } = req.body || {};
      symbol = normalizeSymbolInput(symbol);

      if (!symbol) {
        return res.status(400).json({ ok: false, error: "symbol_required" });
      }

      let finalPrice = Number(price);

      if (!Number.isFinite(finalPrice) || finalPrice <= 0) {
        finalPrice = findLivePriceForSymbol(symbol);
      }

      if (!finalPrice || !Number.isFinite(finalPrice) || finalPrice <= 0) {
        if (!SAFE_FALLBACK) {
          return res.status(400).json({
            ok: false,
            error: "no_price_available",
          });
        }

        finalPrice = getFallbackPrice();
      }

      await updateLivePrice({
        symbol,
        price: finalPrice,
      });

      return res.json({
        ok: true,
        symbol,
        price: Number(finalPrice.toFixed(6)),
        msg: "updated",
      });
    } catch (err) {
      console.error("POST PRICE ERROR:", err);

      return res.status(500).json({
        ok: false,
        error: "server_error",
      });
    }
  });

  // =========================
  // 🔎 DEBUG/EXTRA ROUTES
  // =========================
  router.get("/latest", async (req, res) => {
    try {
      const rawSymbol =
        req.query.symbol ||
        req.query.tvSymbol ||
        req.query.selectedSymbol ||
        req.query.ticker ||
        "";

      const symbol = normalizeSymbolInput(rawSymbol);

      // IMPORTANTE: no devolver 400 si no hay símbolo
      if (!symbol) {
        return res.json({
          ok: true,
          symbol: null,
          price: null,
          currentPrice: null,
          close: null,
          last: null,
          updatedAt: new Date().toISOString(),
          message: "symbol_missing",
        });
      }

      const livePrice = findLivePriceForSymbol(symbol);

      let price = livePrice;

      if (!price) {
        try {
          const store = getPriceStore();
          const found = findBestPriceMatch(symbol, store);

          if (found) {
            price = extractQuotePrice(found);
          }
        } catch {}
      }

      if (!price) {
        if (!SAFE_FALLBACK) {
          return res.json({
            ok: false,
            error: "price_not_found",
            symbol,
            price: null,
            currentPrice: null,
            close: null,
            last: null,
            updatedAt: new Date().toISOString(),
          });
        }

        price = getFallbackPrice();
      }

      const numericPrice = Number(price);

      if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
        return res.json({
          ok: false,
          error: "price_invalid",
          symbol,
          price: null,
          currentPrice: null,
          close: null,
          last: null,
          updatedAt: new Date().toISOString(),
        });
      }

      return res.json({
        ok: true,
        symbol,
        price: Number(numericPrice.toFixed(6)),
        currentPrice: Number(numericPrice.toFixed(6)),
        close: Number(numericPrice.toFixed(6)),
        last: Number(numericPrice.toFixed(6)),
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("LATEST PRICE ERROR:", err);
      return res.status(500).json({ ok: false, error: "server_error", price: null });
    }
  });

  router.get("/quotes", (req, res) => {
    try {
      const store = getPriceStore();
      const quotes = Object.keys(store).map((symbol) => ({
        symbol,
        label: (symbol.split(":").pop() || symbol).replace("_", "/"),
        market: store[symbol]?.market || "Unknown",
        price: extractQuotePrice(store[symbol] || {}),
        updatedAt: store[symbol]?.updatedAt || new Date().toISOString(),
      }));

      return res.json({
        ok: true,
        count: quotes.length,
        quotes,
      });
    } catch (err) {
      console.error("QUOTES ERROR:", err);
      return res.status(500).json({ ok: false, error: "server_error", quotes: [] });
    }
  });

  return router;
}
