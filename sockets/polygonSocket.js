import WebSocket from "ws";
import EventEmitter from "events";
import { endpoints, key as defaultKey, prefixes as defaultPrefixes } from "../config/polygon.js";

/**
 * PolygonSocket — FIXED PRO VERSION
 */
export default class PolygonSocket extends EventEmitter {
  constructor(opts = {}) {
    super();

    this.apiKey = opts.apiKey || defaultKey || null;
    this.ws = {};
    this.reconnectBase = Number(opts.reconnectBase) || 1000;

    this.priceHandler =
      opts.priceHandler ||
      global.priceHandler ||
      (global.priceHandler = { prices: {} });

    // 🔥 GLOBAL CACHE (IMPORTANTE PARA OPENTRADE)
    global.priceCache = global.priceCache || {};
    this.priceCache = global.priceCache;

    this.prefixes = opts.prefixes || defaultPrefixes || {};
  }

  // ======================================================
  // 🔥 CLEAN SYMBOL (FIXED - NO ROMPE FOREX)
  // ======================================================
  _cleanSymbol(symbol) {
    if (!symbol) return null;

    return String(symbol)
      .toUpperCase()
      .replace(/^C\./, "")
      .replace(/^BINANCE:/, "")
      .replace(/^OANDA:/, "")
      .replace(/^FOREX:/, "")
      .replace(/^INDEX:/, "")
      .replace(/^TVC:/, "")
      .trim();
  }

  // ======================================================
  // MARKET GUESS
  // ======================================================
  _guessClass(symbol) {
    const s = String(symbol || "").toUpperCase();

    if (s.includes("BTC") || s.includes("ETH") || s.includes("USDT")) return "crypto";
    if (s.includes("EUR") || s.includes("USD") || s.includes("JPY")) return "forex";
    if (s.includes("SPX") || s.includes("INDEX")) return "indices";
    return "stocks";
  }

  _getEndpoint(cls) {
    return endpoints?.[cls] || null;
  }

  // ======================================================
  // CONNECT ALL MARKETS
  // ======================================================
  connect() {
    Object.keys(endpoints || {}).forEach((cls) => {
      this._connect(cls);
    });
  }

  _connect(cls) {
    const url = this._getEndpoint(cls);
    if (!url) return;

    let ws;

    try {
      ws = new WebSocket(url);
    } catch {
      setTimeout(() => this._connect(cls), this.reconnectBase);
      return;
    }

    this.ws[cls] = ws;

    ws.on("open", () => {
      if (this.apiKey) {
        ws.send(JSON.stringify({ action: "auth", params: this.apiKey }));
      }
    });

    // ======================================================
    // 🔥 MESSAGE HANDLER (FIX FINAL)
    // ======================================================
    ws.on("message", (msg) => {
      let data;

      try {
        data = JSON.parse(msg.toString());
      } catch {
        return;
      }

      const item = Array.isArray(data) ? data[0] : data;
      if (!item) return;

      const rawSymbol =
        item.sym ||
        item.symbol ||
        item.ticker ||
        item.pair ||
        item.s;

      if (!rawSymbol) return;

      // =========================
      // PRICE DETECTION
      // =========================
      let price =
        item.p ??
        item.price ??
        item.last ??
        item.c ??
        (item.bp && item.ap ? (Number(item.bp) + Number(item.ap)) / 2 : null);

      const numericPrice = Number(price);

      if (!Number.isFinite(numericPrice) || numericPrice <= 0) return;

      const symbol = this._cleanSymbol(rawSymbol);
      if (!symbol) return;

      // ======================================================
      // 💾 SAVE TO BOTH SYSTEMS (CRÍTICO FIX)
      // ======================================================
      const payload = {
        symbol,
        price: numericPrice,
        updatedAt: Date.now(),
        raw: item,
      };

      // 🔥 GLOBAL HANDLER
      this.priceHandler.prices[symbol] = payload;

      // 🔥 GLOBAL CACHE (USADO POR OPENTRADE)
      this.priceCache[symbol] = numericPrice;

      console.log("📥 PRICE UPDATE:", symbol, numericPrice);

      this.emit("price", payload);
    });

    ws.on("close", () => {
      setTimeout(() => this._connect(cls), this.reconnectBase);
    });

    ws.on("error", () => {
      setTimeout(() => this._connect(cls), this.reconnectBase);
    });
  }

  // ======================================================
  // SUBSCRIBE SYMBOL
  // ======================================================
  subscribe(symbol) {
    const cls = this._guessClass(symbol);
    const ws = this.ws[cls];

    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const clean = this._cleanSymbol(symbol);

    ws.send(
      JSON.stringify({
        action: "subscribe",
        params: clean,
      })
    );
  }
}
