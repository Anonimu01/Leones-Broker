 // sockets/polygonSocket.js
import WebSocket from "ws";
import EventEmitter from "events";
import { endpoints, key as defaultKey, prefixes as defaultPrefixes } from "../config/polygon.js";

/**
 * PolygonSocket — multi-class socket manager
 * - mantiene una conexión por "class" (stocks, crypto, forex, indices, options)
 * - maneja reconexión con backoff exponencial
 * - cola mensajes si el socket aún no está abierto
 * - emite eventos: 'status', 'raw', 'data', 'error', 'open', 'close'
 *
 * Añadidos:
 * - MARKET_SYMBOLS: listas útiles por mercado (commodities, indices, forex, stocks, sp500, crypto)
 * - Métodos: getAvailableMarkets, getMarketSymbols, subscribeMarket, subscribeAllMarkets
 */

export default class PolygonSocket extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.apiKey = opts.apiKey || defaultKey || null;

    this.ws = {}; // per-class WebSocket instances
    this.pendingSends = {};
    this.subscriptions = {
      stocks: new Set(),
      crypto: new Set(),
      forex: new Set(),
      indices: new Set(),
      options: new Set(),
    };

    // default reconnect/backoff & heartbeat
    this.reconnectBase = Number(opts.reconnectBase) || 1000;
    this.reconnectMax = Number(opts.reconnectMax) || 30_000;
    this.reconnectAttempts = {};
    this.reconnectDelay = {};
    this._connecting = { stocks:false, crypto:false, forex:false, indices:false, options:false };
    this.heartbeatIntervalMs = Number(opts.heartbeatIntervalMs) || 30_000;
    this._heartbeatTimers = {};

    // prefixes from config (Polygon uses "T." for trades normally)
    this.prefixes = opts.prefixes || defaultPrefixes || { trades: "T.", quotes: "Q.", aggs: "A." };

    // init pending queues and reconnect metadata
    Object.keys(this.subscriptions).forEach((k) => {
      this.pendingSends[k] = [];
      this.reconnectAttempts[k] = 0;
      this.reconnectDelay[k] = this.reconnectBase;
    });

    // MARKET SYMBOLS: base listas por mercado (edítalas según lo que uses en Polygon)
    this.MARKET_SYMBOLS = {
      // Materias primas comunes (ejemplos de identificadores; ajusta según proveedor)
      commodities: [
        "CME:CL",     // Crude Oil (WTI) - ejemplo
        "COMEX:GC",   // Gold (Gold Futures) - ejemplo
        "COMEX:SI",   // Silver
        "CME:NG",     // Natural Gas
        "CME:HG"      // Copper
      ],
      // Indices globales
      indices: [
        "INDEX:SPX",  // S&P 500
        "INDEX:DJI",  // Dow Jones
        "INDEX:NDX",  // Nasdaq 100
        "INDEX:FTSE", // FTSE 100 (ajusta si tu feed usa otro identificador)
        "INDEX:DAX"   // DAX
      ],
      // Forex — ejemplos (OANDA style or FOREX: pair)
      forex: [
        "OANDA:EUR_USD",
        "OANDA:GBP_USD",
        "OANDA:USD_JPY",
        "OANDA:USD_CAD",
        "OANDA:AUD_USD"
      ],
      // Acciones (stocks) - grandes caps
      stocks: [
        "NASDAQ:AAPL",
        "NASDAQ:MSFT",
        "NASDAQ:NVDA",
        "NASDAQ:AMZN",
        "NASDAQ:TSLA"
      ],
      // S&P500 como categoría (ya incluído en indices pero te doy acceso directo)
      sp500: [
        "INDEX:SPX", // alias
        "SPX"        // algunos feeds aceptan SPX sin prefix
      ],
      // Crypto (ejemplos en formato BINANCE:)
      crypto: [
        "BINANCE:BTCUSDT",
        "BINANCE:ETHUSDT",
        "BINANCE:SOLUSDT",
        "BINANCE:BNBUSDT",
        "BINANCE:ADAUSDT"
      ]
    };
  }

  // ========== Core connection lifecycle ==========
  connect() { return this.start(); }

  async start() {
    Object.keys(this.subscriptions).forEach((cls) => {
      if (!this.ws[cls]) this._connectClass(cls);
    });
  }

  _guessClass(symbol) {
    if (!symbol) return "stocks";
    const s = String(symbol).toUpperCase();
    if (s.includes("BTC") || s.includes("ETH") || s.includes("USDT") || s.includes("CRYPTO")) return "crypto";
    if (s.includes("/") || s.includes("FX") || s.includes("OANDA") || s.includes("FOREX")) return "forex";
    if (s.startsWith("I:") || s.includes("INDEX") || s.startsWith("IND") || s === "SPX") return "indices";
    if (s.startsWith("O:") || s.includes("OPT") || s.includes("OPTION")) return "options";
    return "stocks";
  }

  _getEndpointFor(cls) {
    if (!cls || !endpoints) return null;
    return endpoints[cls] || null;
  }

  _connectClass(cls) {
    if (this._connecting[cls]) return;
    const url = this._getEndpointFor(cls);
    if (!url) {
      this.emit("status", { cls, status: "no-endpoint" });
      console.warn("PolygonSocket: no endpoint for", cls);
      return;
    }

    this._connecting[cls] = true;
    if (!this.reconnectDelay[cls]) this.reconnectDelay[cls] = this.reconnectBase;

    let conn;
    try {
      conn = new WebSocket(url);
    } catch (err) {
      this._connecting[cls] = false;
      this.emit("status", { cls, status: "error", error: String(err) });
      this._scheduleReconnect(cls);
      return;
    }

    this.ws[cls] = conn;

    conn.on("open", () => {
      this._connecting[cls] = false;
      this.reconnectAttempts[cls] = 0;
      this.reconnectDelay[cls] = this.reconnectBase;
      this.emit("status", { cls, status: "connected" });
      this.emit("open", { cls });

      try {
        if (this.apiKey) {
          conn.send(JSON.stringify({ action: "auth", params: this.apiKey }));
        } else {
          this.emit("status", { cls, status: "warning", message: "no apiKey provided" });
        }
      } catch (e) {
        this.emit("error", e);
      }

      // flush queue + re-subscribe stored symbols
      this._flushPendingSends(cls);
      const params = [...this.subscriptions[cls]];
      if (params && params.length) {
        try {
          conn.send(JSON.stringify({ action: "subscribe", params: params.join(",") }));
        } catch (e) {
          this.pendingSends[cls].push({ type: "subscribe", params });
        }
      }

      this._startHeartbeat(cls);
    });

    conn.on("message", (msg) => {
      const s = typeof msg === "string" ? msg : msg.toString();
      if (s.trim().startsWith("<")) {
        this.emit("raw", { cls, data: s });
        this.emit("error", new Error(`Non-JSON response for ${cls}`));
        return;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(s);
      } catch (e) {
        this.emit("raw", { cls, data: s });
        this.emit("error", new Error(`JSON parse error for ${cls}: ${e.message}`));
        return;
      }
      this.emit("raw", { cls, data: parsed });
      if (Array.isArray(parsed)) parsed.forEach(item => this._handleIncomingItem(cls, item));
      else if (parsed && typeof parsed === "object") {
        if (parsed.ev === "status" || parsed.event === "status" || parsed.type === "status") {
          this.emit("status", { cls, status: parsed.status || parsed.message || parsed.event });
        } else {
          this._handleIncomingItem(cls, parsed);
        }
      }
    });

    conn.on("close", (code, reason) => {
      this.emit("status", { cls, status: "closed", code, reason: (reason && reason.toString) ? reason.toString() : reason });
      this.emit("close", { cls, code, reason });
      this._stopHeartbeat(cls);
      this.ws[cls] = null;
      this._connecting[cls] = false;
      this._scheduleReconnect(cls);
    });

    conn.on("error", (err) => {
      this.emit("status", { cls, status: "error", error: String(err) });
      this.emit("error", err);
      try { conn.close(); } catch (e) {}
      this._stopHeartbeat(cls);
      this.ws[cls] = null;
      this._connecting[cls] = false;
      this._scheduleReconnect(cls);
    });
  }

  _handleIncomingItem(cls, item) {
    try {
      if (item.ev === "status" || item.event === "status" || item.type === "status") {
        this.emit("status", { cls, status: item.status || item.message || item.event });
        return;
      }
      // Emit normalized 'price' payload for convenience if item looks like a trade/quote
      this.emit("data", { cls, item });
    } catch (e) {
      this.emit("error", e);
    }
  }

  _startHeartbeat(cls) {
    this._stopHeartbeat(cls);
    const conn = this.ws[cls];
    if (!conn || conn.readyState !== WebSocket.OPEN) return;
    this._heartbeatTimers[cls] = setInterval(() => {
      try {
        if (conn && conn.readyState === WebSocket.OPEN) {
          if (typeof conn.ping === "function") conn.ping();
          else conn.send(JSON.stringify({ action: "ping" }));
        }
      } catch (e) {}
    }, this.heartbeatIntervalMs);
  }

  _stopHeartbeat(cls) {
    try {
      if (this._heartbeatTimers[cls]) {
        clearInterval(this._heartbeatTimers[cls]);
        this._heartbeatTimers[cls] = null;
      }
    } catch (e) {}
  }

  _scheduleReconnect(cls) {
    this.reconnectAttempts[cls] = (this.reconnectAttempts[cls] || 0) + 1;
    const attempt = this.reconnectAttempts[cls];
    const delay = Math.min(this.reconnectBase * Math.pow(2, attempt - 1), this.reconnectMax);
    this.reconnectDelay[cls] = delay;
    this.emit("status", { cls, status: "reconnect_scheduled", delay });
    setTimeout(() => {
      if (!this.ws[cls] && !this._connecting[cls]) this._connectClass(cls);
    }, delay);
  }

  _flushPendingSends(cls) {
    const conn = this.ws[cls];
    if (!conn || conn.readyState !== WebSocket.OPEN) return;
    const queue = this.pendingSends[cls] || [];
    while (queue.length) {
      const item = queue.shift();
      try {
        if (item.type === "subscribe") {
          const params = Array.isArray(item.params) ? item.params.join(",") : item.params;
          conn.send(JSON.stringify({ action: "subscribe", params }));
        } else if (item.type === "unsubscribe") {
          const params = Array.isArray(item.params) ? item.params.join(",") : item.params;
          conn.send(JSON.stringify({ action: "unsubscribe", params }));
        } else if (item.type === "raw") {
          conn.send(item.payload);
        } else {
          conn.send(JSON.stringify(item));
        }
      } catch (e) {
        queue.unshift(item);
        break;
      }
    }
  }

  // ---------------------------
  // Normalización para Polygon
  // ---------------------------
  _formatForPolygon(symbol, cls) {
    if (!symbol) return symbol;
    let s = String(symbol).trim();

    // Eliminar exchange prefix si viene "EXCHANGE:SYMBOL" (mantener I: y O:)
    if (s.includes(":") && !s.startsWith("I:") && !s.startsWith("O:")) {
      s = s.split(":").pop();
    }

    // Quitar separadores comunes
    s = s.replace(/[\/_\-\s]/g, "");

    // Dejar en mayúsculas
    return s.toUpperCase();
  }

  _normalizeSubscribeStr(symbol, kind = "trades") {
    const prefKey = kind === "quotes" ? "quotes" : kind === "aggs" ? "aggs" : "trades";
    const pref = this.prefixes && this.prefixes[prefKey] ? this.prefixes[prefKey] : (prefKey === "trades" ? "T." : (prefKey === "quotes" ? "Q." : "A."));
    const cls = this._guessClass(symbol);
    const formatted = this._formatForPolygon(symbol, cls);
    return `${pref}${String(formatted).trim()}`;
  }

  // ========== Subscriptions API ==========
  subscribe(symbol, kind = "trades") {
    try {
      const subStr = this._normalizeSubscribeStr(symbol, kind);
      const cls = this._ensureConnFor(symbol);

      if (this.subscriptions[cls].has(subStr)) return;

      this.subscriptions[cls].add(subStr);

      const conn = this.ws[cls];
      if (conn && conn.readyState === WebSocket.OPEN) {
        try {
          conn.send(JSON.stringify({ action: "subscribe", params: subStr }));
        } catch (e) {
          this.pendingSends[cls].push({ type: "subscribe", params: subStr });
        }
      } else {
        this.pendingSends[cls].push({ type: "subscribe", params: subStr });
      }
    } catch (e) {
      this.emit("error", e);
    }
  }

  subscribeMany(symbols = [], kind = "trades") {
    (symbols || []).forEach((s) => this.subscribe(s, kind));
  }

  unsubscribe(symbol, kind = "trades") {
    try {
      const subStr = this._normalizeSubscribeStr(symbol, kind);
      const cls = this._guessClass(symbol);

      if (!this.subscriptions[cls].has(subStr)) return;

      this.subscriptions[cls].delete(subStr);

      const conn = this.ws[cls];
      if (conn && conn.readyState === WebSocket.OPEN) {
        try {
          conn.send(JSON.stringify({ action: "unsubscribe", params: subStr }));
        } catch (e) {
          this.pendingSends[cls].push({ type: "unsubscribe", params: subStr });
        }
      } else {
        this.pendingSends[cls].push({ type: "unsubscribe", params: subStr });
      }
    } catch (e) {
      this.emit("error", e);
    }
  }

  // ======= New: market-level helpers =======
  getAvailableMarkets() {
    return Object.keys(this.MARKET_SYMBOLS);
  }

  getMarketSymbols(market) {
    return (this.MARKET_SYMBOLS[market] || []).slice();
  }

  subscribeMarket(market, kind = "trades") {
    const syms = this.getMarketSymbols(market);
    if (!syms || !syms.length) return { ok: false, msg: "market unknown or empty", market, count: 0 };
    this.subscribeMany(syms, kind);
    return { ok: true, market, count: syms.length };
  }

  subscribeAllMarkets(kind = "trades") {
    const markets = this.getAvailableMarkets();
    let total = 0;
    markets.forEach(m => {
      const syms = this.getMarketSymbols(m);
      if (syms && syms.length) { this.subscribeMany(syms, kind); total += syms.length; }
    });
    return { ok: true, markets: markets.length, total };
  }

  subscribeOverviewMarkets() {
    // Backwards-compat: subscribir ejemplos principales
    const overview = [
      "NASDAQ:AAPL","NASDAQ:MSFT","NASDAQ:NVDA","BINANCE:BTCUSDT","BINANCE:ETHUSDT",
      "OANDA:EUR_USD","INDEX:SPX","CME:CL","COMEX:GC"
    ];
    this.subscribeMany(overview, "trades");
  }

  listSubscriptions() {
    const out = {};
    Object.keys(this.subscriptions).forEach((k) => {
      out[k] = [...this.subscriptions[k]];
    });
    return out;
  }

  _ensureConnFor(symbol) {
    const cls = this._guessClass(symbol);
    if (!this.ws[cls] || this.ws[cls].readyState !== WebSocket.OPEN) {
      this._connectClass(cls);
    }
    return cls;
  }

  isConnected(cls) {
    if (!cls) return Object.keys(this.ws).some((c) => this.ws[c] && this.ws[c].readyState === WebSocket.OPEN);
    return !!(this.ws[cls] && this.ws[cls].readyState === WebSocket.OPEN);
  }

  async close() {
    Object.keys(this.ws).forEach((cls) => {
      try {
        this._stopHeartbeat(cls);
        const conn = this.ws[cls];
        if (conn && typeof conn.close === "function") conn.close();
      } catch (e) {}
      this.ws[cls] = null;
    });
  }
}
