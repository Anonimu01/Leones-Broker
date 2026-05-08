import WebSocket from "ws";
import EventEmitter from "events";
import { endpoints, key as defaultKey, prefixes as defaultPrefixes } from "../config/polygon.js";

/**
 * PolygonSocket — FIXED VERSION (PRICE STABLE + SYMBOL NORMALIZATION)
 */
export default class PolygonSocket extends EventEmitter {
  constructor(opts = {}) {
    super();

    this.apiKey = opts.apiKey || defaultKey || null;

    this.ws = {};
    this.pendingSends = {};

    this.reconnectBase = Number(opts.reconnectBase) || 1000;

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

    this.priceHandler =
      opts.priceHandler ||
      global.priceHandler ||
      (global.priceHandler = {
        prices: new Map(),
      });

    this.pendingSends = {};
  }

  // ======================================================
  // NORMALIZAR SYMBOL (🔥 FIX CLAVE)
  // ======================================================
  _cleanSymbol(symbol) {
    if (!symbol) return "";

    return String(symbol)
      .toUpperCase()
      .replace("BINANCE:", "")
      .replace("OANDA:", "")
      .replace("TVC:", "")
      .replace("FOREX:", "")
      .replace("INDEX:", "")
      .replace("C:", "")
      .replace("X:", "")
      .replace("/", "")
      .trim();
  }

  _guessClass(symbol) {
    const s = String(symbol || "").toUpperCase();

    if (s.includes("BTC") || s.includes("ETH") || s.includes("USDT")) return "crypto";
    if (s.includes("EUR") || s.includes("USD") || s.includes("JPY")) return "forex";
    if (s.startsWith("I") || s.includes("SPX")) return "indices";
    return "stocks";
  }

  _getEndpointFor(cls) {
    return endpoints?.[cls] || null;
  }

  // ======================================================
  // CONNECT
  // ======================================================
  connect() {
    Object.keys(endpoints || {}).forEach((cls) => {
      if (!this.ws[cls]) this._connect(cls);
    });
  }

  _connect(cls) {
    const url = this._getEndpointFor(cls);
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
    // 🔥 FIX PRINCIPAL DE PRECIOS
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

      let price =
        item.p ||
        item.price ||
        item.last ||
        item.c ||
        item.close;

      if (!rawSymbol || price == null) return;

      const symbol = this._cleanSymbol(rawSymbol);
      const numericPrice = Number(price);

      if (!Number.isFinite(numericPrice) || numericPrice <= 0) return;

      // ======================================================
      // 💾 STORE GLOBAL (ESTO ES LO QUE TE FALTABA)
      // ======================================================
      const payload = {
        symbol,
        price: numericPrice,
        updatedAt: new Date().toISOString(),
      };

      // Map seguro
      if (this.priceHandler.prices instanceof Map) {
        this.priceHandler.prices.set(symbol, payload);
      } else {
        this.priceHandler.prices[symbol] = payload;
      }

      console.log("📥 PRICE OK:", symbol, numericPrice);

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
  // SUBSCRIBE FIX
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
