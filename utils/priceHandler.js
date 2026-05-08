import { EventEmitter } from "events";

const priceStore = {};

class PriceHandler extends EventEmitter {
  constructor(io = null) {
    super();
    this.io = io;
    this.prices = priceStore;
  }

  _normalizeSymbol(raw) {
    if (!raw) return null;

    let s = String(raw)
      .trim()
      .toUpperCase();

    if (s.includes(":") && !s.startsWith("I:") && !s.startsWith("O:")) {
      s = s.split(":").pop();
    }

    return s.replace(/[_\s\-\/]/g, "");
  }

  handlePolygonItem({ cls, item }) {
    if (!item) return;

    try {
      const sym = item.sym || item.ticker || item.S || item.s;
      if (!sym) return;

      let price = null;

      // =========================
      // TRADE (MEJOR PRECIO REAL)
      // =========================
      if (item.ev === "T" || item.ev === "trade") {
        price = item.p ?? item.price ?? item.last;
      }

      // =========================
      // QUOTE (BID/ASK fallback)
      // =========================
      else if (item.ev === "Q" || item.ev === "quote") {
        const bid = Number(item.bp ?? item.bid);
        const ask = Number(item.ap ?? item.ask);

        if (bid && ask) {
          price = (bid + ask) / 2;
        } else {
          price = bid || ask;
        }
      }

      // =========================
      // FALLBACK GENERAL
      // =========================
      else {
        price = item.p ?? item.price ?? item.last ?? null;
      }

      price = Number(price);

      if (!Number.isFinite(price) || price <= 0) return;

      this._updatePrice(sym, price, Date.now(), {
        cls,
        raw: item,
      });

    } catch (e) {
      this.emit("error", e);
    }
  }

  _updatePrice(symbolRaw, price, ts, meta) {
    const sym = this._normalizeSymbol(symbolRaw);
    if (!sym) return;

    const prev = this.prices[sym];
    const prevPrice = prev?.price ?? null;

    const change = prevPrice !== null ? price - prevPrice : 0;

    this.prices[sym] = {
      price,
      ts,
      prevPrice,
      change,
      raw: meta.raw || null,
    };

    const payload = {
      symbol: sym,
      price,
      ts,
      change,
    };

    this.emit("price", payload);

    if (this.io) {
      this.io.emit("price", payload);
      this.io.to(sym).emit("price", payload);
    }
  }

  getPrice(symbol) {
    const s = this._normalizeSymbol(symbol);
    return this.prices[s] || null;
  }

  getAllPrices() {
    return { ...this.prices };
  }
}

export default PriceHandler;
