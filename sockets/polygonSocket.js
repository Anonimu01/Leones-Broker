import WebSocket from "ws";
import EventEmitter from "events";
import { endpoints, key as defaultKey, prefixes as defaultPrefixes } from "../config/polygon.js";

/**
 * PolygonSocket — FINAL FIXED VERSION (STABLE PRICES)
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
      (global.priceHandler = {
        prices: {},
      });

    this._connecting = {};
    this.prefixes = opts.prefixes || defaultPrefixes || {};
  }

  // ======================================================
  // NORMALIZAR SYMBOL (CRÍTICO)
  // ======================================================
  _cleanSymbol(symbol) {
    if (!symbol) return null;

    return String(symbol)
      .toUpperCase()
      .replace("BINANCE:", "")
      .replace("OANDA:", "")
      .replace("FOREX:", "")
      .replace("INDEX:", "")
      .replace("TVC:", "")
      .replace("C:", "")
      .replace("/", "")
      .replace("_", "")
      .trim();
  }

  // ======================================================
  // CLASIFICAR MERCADO
  // ======================================================
  _guessClass(symbol) {
    const s = String(symbol || "").toUpperCase();

    if (s.includes("BTC") || s.includes("ETH") || s.includes("USDT")) return "crypto";
    if (s.includes("EUR") || s.includes("USD") || s.includes("JPY")) return "forex";
    if (s.includes("SPX") || s.includes("INDEX")) return "indices";
    return "stocks";
  }

  // ======================================================
  // ENDPOINT
  // ======================================================
  _getEndpoint(cls) {
    return endpoints?.[cls] || null;
  }

  // ======================================================
  // CONNECT
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
    } catch (err) {
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
    // 🔥 DATA HANDLER FINAL
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
      // PRICE DETECTION (ROBUSTO)
      // =========================
      let price = null;

      // trade
      if (item.p != null) price = item.p;

      // fallback quote
      else if (item.price != null) price = item.price;
      else if (item.last != null) price = item.last;
      else if (item.c != null) price = item.c;

      // bid/ask fallback
      else if (item.bp && item.ap) {
        price = (Number(item.bp) + Number(item.ap)) / 2;
      }

      if (price == null) return;

      const numericPrice = Number(price);
      if (!Number.isFinite(numericPrice) || numericPrice <= 0) return;

      const symbol = this._cleanSymbol(rawSymbol);
      if (!symbol) return;

      // ======================================================
      // 💾 STORE FINAL (UNIFICADO)
      // ======================================================
      this.priceHandler.prices[symbol] = {
        symbol,
        price: numericPrice,
        updatedAt: Date.now(),
        raw: item,
      };

      console.log("📥 PRICE:", symbol, numericPrice);

      this.emit("price", {
        symbol,
        price: numericPrice,
      });
    });

    ws.on("close", () => {
      setTimeout(() => this._connect(cls), this.reconnectBase);
    });

    ws.on("error", () => {
      setTimeout(() => this._connect(cls), this.reconnectBase);
    });
  }

  // ======================================================
  // SUBSCRIBE
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
