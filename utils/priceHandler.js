// utils/priceHandler.js
import { EventEmitter } from "events";

const priceStore = {}; // { symbol: { price, ts, raw, prevPrice } }

class PriceHandler extends EventEmitter {
  constructor(io = null) {
    super();
    this.io = io;
    this.prices = priceStore;
  }

  /**
   * Normaliza símbolos para usar como key interna
   * Ejemplos:
   *  - "BINANCE:BTCUSDT" -> "BTCUSDT"
   *  - "EUR/USD" -> "EURUSD"
   *  - "OANDA:EUR_USD" -> "EURUSD"
   */
  _normalizeSymbol(raw) {
    if (!raw) return null;
    let s = String(raw).trim();

    // si viene con exchange "EXCHANGE:SYMBOL", quitar exchange (pero conservar special prefixes I:, O: si es opción/índice)
    if (s.includes(":") && !s.startsWith("I:") && !s.startsWith("O:")) {
      s = s.split(":").pop();
    }

    // quitar separadores comunes
    s = s.replace(/[_\s\-\/]/g, "").toUpperCase();

    return s || null;
  }

  /**
   * Handler principal: recibe items desde PolygonSocket
   * { cls, item }
   */
  handlePolygonItem({ cls, item }) {
    if (!item) return;

    try {
      // trade events (varios formatos)
      if (item.ev === "T" || item.ev === "t" || item.ev === "trade") {
        const sym = item.sym || item.ticker || item.S || item.s || item.symb || null;
        const price = Number(item.p ?? item.price ?? item.last ?? 0);
        const size = Number(item.s ?? item.size ?? item.si ?? 0);
        const ts = item.t ?? item.ts ?? Date.now();

        if (!isFinite(price)) return this.emit("raw_unhandled", { cls, item });
        this._updatePrice(sym, price, Number(ts), { cls, raw: item, type: "trade", size });
      }

      // quote events
      else if (item.ev === "Q" || item.ev === "quote") {
        const sym = item.sym || item.ticker || item.S || null;
        const bid = Number(item.bp ?? item.bid ?? 0);
        const ask = Number(item.ap ?? item.ask ?? 0);
        const ts = item.t ?? item.ts ?? Date.now();
        const mid = (isFinite(bid) && isFinite(ask) && bid && ask) ? ((bid + ask) / 2) : (isFinite(bid) ? bid : (isFinite(ask) ? ask : NaN));

        if (!isFinite(mid)) return this.emit("raw_unhandled", { cls, item });
        this._updatePrice(sym, mid, Number(ts), { cls, raw: item, type: "quote", bid, ask });
      }

      // status / heartbeat
      else if (item.ev === "status" || item.event === "status" || item.type === "status") {
        this.emit("status", item);
      }

      // fallback: try to extract price from other fields
      else {
        const sym = item.sym || item.ticker || item.S || item.s || null;
        const price = Number(item.p ?? item.price ?? item.last ?? NaN);
        const ts = item.t ?? item.ts ?? Date.now();

        if (sym && isFinite(price)) {
          this._updatePrice(sym, price, Number(ts), { cls, raw: item, type: "other" });
        } else {
          this.emit("raw_unhandled", { cls, item });
        }
      }
    } catch (e) {
      this.emit("error", e);
    }
  }

  /**
   * Actualiza el store y emite eventos
   */
  _updatePrice(symbolRaw, price, ts = Date.now(), meta = {}) {
    const sym = this._normalizeSymbol(symbolRaw);
    if (!sym || !isFinite(Number(price))) return;

    const prev = this.prices[sym] || {};
    const prevPrice = isFinite(Number(prev.price)) ? prev.price : null;
    const change = (prevPrice !== null) ? (Number(price) - prevPrice) : 0;

    // store minimal
    this.prices[sym] = {
      price: Number(price),
      ts: Number(ts),
      raw: meta.raw || null,
      prevPrice: prevPrice
    };

    const payload = {
      symbol: sym,
      price: Number(price),
      ts: Number(ts),
      change,
      meta
    };

    // emitir evento local
    this.emit("price", payload);

    // emitir a todos los sockets (global) - mantiene compatibilidad
    if (this.io) {
      try {
        // emitir global
        this.io.emit("price", payload);

        // también emitir por room (si hay clientes suscritos por symbol)
        try {
          this.io.to(sym).emit("price", payload);
        } catch (e) {
          // no crítico; seguir
        }
      } catch (e) {
        console.warn("io emit price error", e);
      }
    }
  }

  getPrice(symbol) {
    const s = this._normalizeSymbol(symbol);
    if (!s) return null;
    return this.prices[s] || null;
  }

  getAllPrices() {
    // retorna copia superficial para evitar mutaciones externas
    return Object.keys(this.prices).reduce((acc, k) => {
      acc[k] = { ...this.prices[k] };
      return acc;
    }, {});
  }

  getSymbols() {
    return Object.keys(this.prices);
  }
}

export default PriceHandler;
