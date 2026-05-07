// sockets/polygonSocket.js
import WebSocket from "ws";
import EventEmitter from "events";
import {
  endpoints,
  key as defaultKey,
  prefixes as defaultPrefixes
} from "../config/polygon.js";

/**
 * PolygonSocket — FIXED VERSION (ROBUST PRICE ENGINE)
 */
export default class PolygonSocket extends EventEmitter {
  constructor(opts = {}) {
    super();

    this.apiKey = opts.apiKey || defaultKey || null;

    this.ws = {};
    this.pendingSends = {};

    this.subscriptions = {
      stocks: new Set(),
      crypto: new Set(),
      forex: new Set(),
      indices: new Set(),
      options: new Set(),
    };

    this.reconnectBase = Number(opts.reconnectBase) || 1000;
    this.reconnectMax = Number(opts.reconnectMax) || 30000;

    this._connecting = {
      stocks: false,
      crypto: false,
      forex: false,
      indices: false,
      options: false,
    };

    this.prefixes = opts.prefixes || defaultPrefixes || {
      trades: "T.",
      quotes: "Q.",
      aggs: "A.",
    };

    Object.keys(this.subscriptions).forEach((k) => {
      this.pendingSends[k] = [];
    });

    this.priceHandler = opts.priceHandler || global.priceHandler;
  }

  connect() {
    return this.start();
  }

  async start() {
    Object.keys(this.subscriptions).forEach((cls) => {
      if (!this.ws[cls]) this._connectClass(cls);
    });
  }

  // ======================================================
  // 🔥 CLEAN SYMBOL (IMPROVED)
  // ======================================================
  _cleanSymbol(symbol = "") {
    return String(symbol)
      .toUpperCase()
      .replace(/^OANDA:/, "")
      .replace(/^TVC:/, "")
      .replace(/^C:/, "")
      .replace(/\//g, "")
      .trim();
  }

  _guessClass(symbol = "") {
    const s = String(symbol).toUpperCase();

    if (s.includes("BTC") || s.includes("ETH") || s.includes("USDT")) return "crypto";
    if (s.includes("/") || s.includes("OANDA") || s.includes("FX")) return "forex";
    if (s.startsWith("I:") || s.includes("INDEX")) return "indices";
    if (s.startsWith("O:")) return "options";

    return "stocks";
  }

  _getEndpointFor(cls) {
    return endpoints?.[cls] || null;
  }

  // ======================================================
  // 🔥 CONNECT
  // ======================================================
  _connectClass(cls) {
    if (this._connecting[cls]) return;

    const url = this._getEndpointFor(cls);
    if (!url) return;

    this._connecting[cls] = true;

    let conn;

    try {
      conn = new WebSocket(url);
    } catch (err) {
      this._connecting[cls] = false;
      this._scheduleReconnect(cls);
      return;
    }

    this.ws[cls] = conn;

    conn.on("open", () => {
      this._connecting[cls] = false;

      if (this.apiKey) {
        conn.send(JSON.stringify({
          action: "auth",
          params: this.apiKey
        }));
      }

      this._flushPendingSends(cls);
    });

    // ======================================================
    // 🔥 FIX PRINCIPAL: MESSAGE PARSER ROBUSTO
    // ======================================================
    conn.on("message", (msg) => {
      let parsed;

      try {
        parsed = JSON.parse(msg.toString());
      } catch {
        return;
      }

      const item = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!item) return;

      // ======================================================
      // 🔥 SYMBOL FIX
      // ======================================================
      const symbol =
        item.sym ||
        item.symbol ||
        item.ticker ||
        item.pair ||
        item.T ||
        item.s;

      if (!symbol) return;

      const cleanSymbol = this._cleanSymbol(symbol);

      // ======================================================
      // 🔥 PRICE EXTRACTION ROBUSTA
      // ======================================================
      const rawPrice =
        item.p ??
        item.price ??
        item.last ??
        item.c ??
        item.ap ??
        item.bp ??
        item.mid ??
        item.vw ??
        null;

      const price = Number(rawPrice);

      if (!Number.isFinite(price) || price <= 0) return;

      // ======================================================
      // 🔥 STORE FIXED (Map OR Object safe)
      // ======================================================
      if (this.priceHandler?.prices) {
        if (this.priceHandler.prices instanceof Map) {
          this.priceHandler.prices.set(cleanSymbol, price);
        } else {
          this.priceHandler.prices[cleanSymbol] = price;
        }
      }

      // DEBUG
      console.log("📥 PRICE UPDATE:", cleanSymbol, price);

      // EVENT
      this.emit("data", {
        cls,
        symbol: cleanSymbol,
        price,
        raw: item,
      });
    });

    conn.on("close", () => {
      this._connecting[cls] = false;
      this._scheduleReconnect(cls);
    });

    conn.on("error", () => {
      this._connecting[cls] = false;
      this._scheduleReconnect(cls);
    });
  }

  // ======================================================
  _scheduleReconnect(cls) {
    setTimeout(() => this._connectClass(cls), this.reconnectBase);
  }

  // ======================================================
  _flushPendingSends(cls) {
    const conn = this.ws[cls];
    if (!conn || conn.readyState !== WebSocket.OPEN) return;

    const queue = this.pendingSends[cls] || [];
    while (queue.length) {
      conn.send(JSON.stringify(queue.shift()));
    }
  }

  // ======================================================
  subscribe(symbol) {
    const cls = this._guessClass(symbol);
    const conn = this.ws[cls];

    if (!conn || conn.readyState !== WebSocket.OPEN) return;

    const clean = this._cleanSymbol(symbol);

    conn.send(JSON.stringify({
      action: "subscribe",
      params: clean
    }));
  }
}
