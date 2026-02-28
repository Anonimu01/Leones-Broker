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
 */
export default class PolygonSocket extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.apiKey = opts.apiKey || defaultKey || null;

    // per-class ws connection + metadata
    this.ws = {}; // { cls: WebSocket }
    this.pendingSends = {}; // { cls: [ {type:'auth'|'subscribe'|... , payload } ] }
    this.subscriptions = {
      stocks: new Set(),
      crypto: new Set(),
      forex: new Set(),
      indices: new Set(),
      options: new Set(),
    };

    this.reconnectBase = Number(opts.reconnectBase) || 1000;
    this.reconnectMax = Number(opts.reconnectMax) || 30_000;
    this.reconnectAttempts = {}; // per class
    this.reconnectDelay = {}; // computed per class

    this._connecting = {
      stocks: false,
      crypto: false,
      forex: false,
      indices: false,
      options: false,
    };

    // heartbeat interval (ms) per connection — server must support ping/pong or heartbeat messages
    this.heartbeatIntervalMs = Number(opts.heartbeatIntervalMs) || 30_000;
    this._heartbeatTimers = {}; // per class

    // prefixes (from config or defaults)
    this.prefixes = opts.prefixes || defaultPrefixes || { trades: "T.", quotes: "Q.", aggs: "A." };

    // ensure pendingSends map has keys
    Object.keys(this.subscriptions).forEach((k) => {
      this.pendingSends[k] = [];
      this.reconnectAttempts[k] = 0;
      this.reconnectDelay[k] = this.reconnectBase;
    });
  }

  connect() {
    return this.start();
  }

  async start() {
    Object.keys(this.subscriptions).forEach((cls) => {
      if (!this.ws[cls]) this._connectClass(cls);
    });
  }

  _guessClass(symbol) {
    if (!symbol) return "stocks";

    const s = String(symbol).toUpperCase();

    if (s.includes("BTC") || s.includes("ETH") || s.includes("USDT") || s.includes("USD")) return "crypto";
    if (s.includes("/") || s.includes("FX") || s.includes("OANDA") || s.includes("FOREX") || /[A-Z]{6,}_?/.test(s)) return "forex";
    if (s.startsWith("I:") || s.includes("INDEX") || s.startsWith("IND")) return "indices";
    if (s.startsWith("O:") || s.includes("OPT") || s.includes("OPTION")) return "options";

    return "stocks";
  }

  _getEndpointFor(cls) {
    if (!endpoints || !endpoints[cls]) {
      return null;
    }
    return endpoints[cls];
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
    // reset reconnect delay if first try
    if (!this.reconnectDelay[cls]) this.reconnectDelay[cls] = this.reconnectBase;

    let conn;
    try {
      conn = new WebSocket(url);
    } catch (err) {
      this._connecting[cls] = false;
      this.emit("status", { cls, status: "error", error: String(err) });
      // schedule retry
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

      // Auth: many polygon endpoints accept either a raw key or an auth action
      try {
        if (this.apiKey) {
          // Try safe auth object first; some endpoints expect plain key, some expect JSON action
          conn.send(JSON.stringify({ action: "auth", params: this.apiKey }));
        } else {
          this.emit("status", { cls, status: "warning", message: "no apiKey provided" });
        }
      } catch (e) {
        this.emit("error", e);
      }

      // flush pending sends (subscribe/unsubscribe/messages)
      this._flushPendingSends(cls);

      // re-subscribe existing subscription set (in case connection lost and reconnected)
      const params = [...this.subscriptions[cls]];
      if (params && params.length) {
        try {
          conn.send(JSON.stringify({ action: "subscribe", params: params.join(",") }));
        } catch (e) {
          // add to pending if cannot send now
          this.pendingSends[cls].push({ type: "subscribe", params });
        }
      }

      // start heartbeat/ping if configured
      this._startHeartbeat(cls);
    });

    conn.on("message", (msg) => {
      // always accept Buffer or string
      const s = typeof msg === "string" ? msg : msg.toString();

      // defensive: if server returned HTML or other non-json (starts with '<'), emit raw and skip parse
      if (s.trim().startsWith("<")) {
        this.emit("raw", { cls, data: s });
        this.emit("error", new Error(`Non-JSON response for ${cls} (starts with <). Possibly an HTTP error page.`));
        return;
      }

      let parsed = null;
      try {
        parsed = JSON.parse(s);
      } catch (e) {
        // Not JSON: emit raw so caller can inspect
        this.emit("raw", { cls, data: s });
        this.emit("error", new Error(`JSON parse error for ${cls}: ${e.message}`));
        return;
      }

      // parsed can be an object or array
      this.emit("raw", { cls, data: parsed });

      // If it's an array of events
      if (Array.isArray(parsed)) {
        parsed.forEach((item) => {
          this._handleIncomingItem(cls, item);
        });
      } else if (typeof parsed === "object" && parsed !== null) {
        if (parsed.ev || parsed.event || parsed.type) {
          if (parsed.ev === "status" || parsed.event === "status" || parsed.type === "status") {
            this.emit("status", { cls, status: parsed.status || parsed.message || parsed.event });
          } else {
            this._handleIncomingItem(cls, parsed);
          }
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
      // schedule reconnect
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
      // polygon-like 'status' event
      if (item.ev === "status" || item.event === "status" || item.type === "status") {
        this.emit("status", { cls, status: item.status || item.message || item.event });
        return;
      }
      // Normal trade/quote object
      this.emit("data", { cls, item });
    } catch (e) {
      this.emit("error", e);
    }
  }

  _startHeartbeat(cls) {
    this._stopHeartbeat(cls);
    const conn = this.ws[cls];
    if (!conn || conn.readyState !== WebSocket.OPEN) return;
    // ping every heartbeatIntervalMs if server supports it
    this._heartbeatTimers[cls] = setInterval(() => {
      try {
        if (conn && conn.readyState === WebSocket.OPEN) {
          if (typeof conn.ping === "function") {
            conn.ping();
          } else {
            conn.send(JSON.stringify({ action: "ping" }));
          }
        }
      } catch (e) {
        // ignore, will be handled by error/close events
      }
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
    // exponential backoff capped
    this.reconnectAttempts[cls] = (this.reconnectAttempts[cls] || 0) + 1;
    const attempt = this.reconnectAttempts[cls];
    const delay = Math.min(this.reconnectBase * Math.pow(2, attempt - 1), this.reconnectMax);
    this.reconnectDelay[cls] = delay;
    this.emit("status", { cls, status: "reconnect_scheduled", delay });
    setTimeout(() => {
      // only try if not already connecting and no live socket
      if (!this.ws[cls] && !this._connecting[cls]) {
        this._connectClass(cls);
      }
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
        // on failure push back and break to avoid tight loops
        queue.unshift(item);
        break;
      }
    }
  }

  // ---------------------------
  // Normalización para Polygon
  // ---------------------------
  _formatForPolygon(symbol, cls) {
    // Recibe: "BINANCE:BTCUSDT", "EUR/USD", "I:SPX", "AAPL"
    if (!symbol) return symbol;
    let s = String(symbol).trim();

    // Si viene con exchange prefix "EXCHANGE:SYMBOL" -> quitar la parte del exchange
    if (s.includes(":") && !s.startsWith("I:") && !s.startsWith("O:")) {
      // mantiene símbolos tipo "I:SPX" (indices) y "O:..." (opciones)
      s = s.split(":").pop();
    }

    // Forex: Polygon suele usar sin slash
    if (cls === "forex") {
      s = s.replace("/", "").replace("_", "");
    }

    // Crypto: unifica separadores, quita "-" o "/"
    if (cls === "crypto") {
      s = s.replace("/", "").replace("-", "");
      // No forzamos USDT->USD conversion automáticamente
    }

    // Stocks / others: limpiar espacios
    s = s.replace(/\s+/g, "");

    return s;
  }

  _normalizeSubscribeStr(symbol, kind = "trades") {
    const pref = this.prefixes[
      kind === "quotes" ? "quotes" : kind === "aggs" ? "aggs" : "trades"
    ] || "";

    // adivina clase para normalizar si es necesario
    const cls = this._guessClass(symbol);
    const formatted = this._formatForPolygon(symbol, cls);

    return `${pref}${String(formatted).trim()}`;
  }

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

  subscribeOverviewMarkets() {
    const overviewSymbols = [
      // STOCKS
      "AAPL", "MSFT", "NVDA", "AMZN", "TSLA",
      // CRYPTO
      "BTCUSD", "ETHUSD", "SOLUSD", "BNBUSD",
      // FOREX
      "EUR/USD", "GBP/USD", "USD/JPY", "USD/CAD",
      // INDICES
      "I:SPX", "I:DJI", "I:NDX",
      // OPTIONS
      "O:AAPL240621C00150000",
      "O:TSLA240621P00200000"
    ];
    this.subscribeMany(overviewSymbols, "trades");
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
    // Close all connections gracefully
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
