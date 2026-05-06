// sockets/polygonSocket.js
import WebSocket from "ws";
import EventEmitter from "events";
import { endpoints, key as defaultKey, prefixes as defaultPrefixes } from "../config/polygon.js";

/**
 * PolygonSocket — multi-class socket manager
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
    this.reconnectAttempts = {};
    this.reconnectDelay = {};

    this._connecting = {
      stocks: false,
      crypto: false,
      forex: false,
      indices: false,
      options: false,
    };

    this.heartbeatIntervalMs = Number(opts.heartbeatIntervalMs) || 30000;
    this._heartbeatTimers = {};

    this.prefixes = opts.prefixes || defaultPrefixes || {
      trades: "T.",
      quotes: "Q.",
      aggs: "A.",
    };

    Object.keys(this.subscriptions).forEach((k) => {
      this.pendingSends[k] = [];
      this.reconnectAttempts[k] = 0;
      this.reconnectDelay[k] = this.reconnectBase;
    });

    // 🔥 IMPORTANTE: referencia al priceHandler global
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
  // 🔥 FIX PRINCIPAL: NORMALIZAR SYMBOL
  // ======================================================
  _cleanSymbol(symbol) {
    return String(symbol || "")
      .toUpperCase()
      .replace("OANDA:", "")
      .replace("TVC:", "")
      .replace("C:", "")
      .replace("/", "")
      .trim();
  }

  _guessClass(symbol) {
    if (!symbol) return "stocks";
    const s = String(symbol).toUpperCase();

    if (s.includes("BTC") || s.includes("ETH") || s.includes("USDT") || s.includes("USD")) return "crypto";
    if (s.includes("/") || s.includes("FX") || s.includes("OANDA")) return "forex";
    if (s.startsWith("I:") || s.includes("INDEX")) return "indices";
    if (s.startsWith("O:")) return "options";
    return "stocks";
  }

  _getEndpointFor(cls) {
    return endpoints?.[cls] || null;
  }

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
        conn.send(JSON.stringify({ action: "auth", params: this.apiKey }));
      }

      this._flushPendingSends(cls);
    });

    // ======================================================
    // 🔥 FIX REAL: GUARDAR PRECIOS EN MEMORIA
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

      const symbol =
        item.sym ||
        item.symbol ||
        item.ticker ||
        item.pair;

      const price =
        item.p ||
        item.price ||
        item.last ||
        item.c;

      if (!symbol || price === undefined) return;

      const clean = this._cleanSymbol(symbol);

      // 🔥 GUARDAR EN MEMORIA GLOBAL
      if (this.priceHandler?.prices) {
        if (this.priceHandler.prices instanceof Map) {
          this.priceHandler.prices.set(clean, Number(price));
        } else {
          this.priceHandler.prices[clean] = Number(price);
        }
      }

      // debug
      console.log("📥 PRICE UPDATE:", clean, price);

      this.emit("data", { cls, item });
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

  _scheduleReconnect(cls) {
    setTimeout(() => this._connectClass(cls), this.reconnectBase);
  }

  _flushPendingSends(cls) {
    const conn = this.ws[cls];
    if (!conn || conn.readyState !== WebSocket.OPEN) return;

    const queue = this.pendingSends[cls] || [];
    while (queue.length) {
      const item = queue.shift();
      conn.send(JSON.stringify(item));
    }
  }

  subscribe(symbol) {
    const cls = this._guessClass(symbol);
    const conn = this.ws[cls];

    if (!conn || conn.readyState !== WebSocket.OPEN) return;

    const sub = this._cleanSymbol(symbol);

    conn.send(JSON.stringify({
      action: "subscribe",
      params: sub
    }));
  }
}
