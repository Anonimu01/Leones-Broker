import { EventEmitter } from "events";

const store = {};

class PriceHandler extends EventEmitter {
  constructor(io = null) {
    super();
    this.io = io;
    this.prices = store;
  }

  normalize(sym) {
    if (!sym) return null;

    let s = String(sym).toUpperCase();

    if (s.includes(":") && !s.startsWith("I:") && !s.startsWith("O:")) {
      s = s.split(":").pop();
    }

    return s.replace(/[_\/\-\s]/g, "");
  }

  handlePolygonItem({ item }) {
    if (!item) return;

    const symbol = item.sym || item.ticker || item.S || item.s;
    if (!symbol) return;

    let price = null;

    // 🔥 TRADE (mejor fuente)
    if (item.ev === "T") {
      price = item.p ?? item.price ?? item.last;
    }

    // 🔥 QUOTE (fallback inteligente)
    else if (item.ev === "Q") {
      const bid = Number(item.bp);
      const ask = Number(item.ap);

      if (bid && ask) {
        price = (bid + ask) / 2;
      } else {
        price = bid || ask;
      }
    }

    // 🔥 FALLBACK GENERAL
    else {
      price = item.p ?? item.price ?? item.last;
    }

    price = Number(price);

    if (!Number.isFinite(price) || price <= 0) return;

    this._save(symbol, price, item);
  }

  _save(symbol, price, raw) {
    const s = this.normalize(symbol);
    if (!s) return;

    const prev = this.prices[s]?.price ?? null;
    const change = prev ? price - prev : 0;

    this.prices[s] = {
      price,
      change,
      ts: Date.now(),
      raw
    };

    const payload = {
      symbol: s,
      price,
      change
    };

    this.emit("price", payload);

    if (this.io) {
      this.io.emit("price", payload);
    }
  }

  getPrice(symbol) {
    return this.prices[this.normalize(symbol)] || null;
  }

  getAllPrices() {
    return this.prices;
  }
}

export default PriceHandler;
