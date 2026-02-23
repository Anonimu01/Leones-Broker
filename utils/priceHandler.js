// utils/priceHandler.js
const EventEmitter = require('events');
const priceStore = {}; // { symbol: { price, ts, raw } }

class PriceHandler extends EventEmitter {
  constructor(io){
    super();
    this.io = io; // socket.io instance (optional)
    this.prices = priceStore;
  }

  handlePolygonItem({ cls, item }) {
    // Polygon returns arrays of event objects (ev indicates type)
    // ev types example: 'T' (trade), 'Q' (quote), 'A' (agg) or textual keys like 'status'
    const ev = item.ev || item.ev?.toString?.();
    if(!ev && item.ev === undefined) {
      // some payloads are different, try trade shape
      // harmless to try
    }

    // Normalize trade events (common polygon fields: sym, p=price, s=size, t=timestamp)
    if(item.ev === 'T' || item.ev === 't' || item.ev === 'trade' || item.ev.ev === 'T') {
      const sym = item.sym || item.ticker || item.S || item.sym;
      const price = Number(item.p ?? item.price ?? item.last ?? 0);
      const size = Number(item.s ?? item.size ?? 0);
      const ts = item.t || Date.now();
      this._updatePrice(sym, price, ts, { cls, raw: item, type: 'trade', size });
    } else if(item.ev === 'Q' || item.ev === 'quote') {
      const sym = item.sym || item.ticker;
      const bid = Number(item.bp ?? item.bid ?? 0);
      const ask = Number(item.ap ?? item.ask ?? 0);
      const ts = item.t || Date.now();
      const mid = (bid && ask) ? ((bid + ask) / 2) : (bid || ask || 0);
      this._updatePrice(sym, mid, ts, { cls, raw: item, type: 'quote', bid, ask });
    } else if(item.ev === 'status') {
      // ignore or emit
      this.emit('status', item);
    } else {
      // try fallback: item.sym && item.p
      const sym = item.sym || item.ticker || item.S;
      if(sym && (item.p || item.price)) {
        this._updatePrice(sym, Number(item.p || item.price), item.t || Date.now(), { cls, raw: item, type: 'other' });
      } else {
        // unknown message shape -> emit raw for debugging
        this.emit('raw_unhandled', { cls, item });
      }
    }
  }

  _updatePrice(symbol, price, ts, meta = {}) {
    if(!symbol) return;
    const s = symbol.includes(':') ? symbol.split(':').pop() : symbol;
    const prev = this.prices[s] || {};
    const payload = {
      symbol: s,
      price: price,
      ts: ts,
      change: (prev.price ? (price - prev.price) : 0),
      meta
    };
    this.prices[s] = { price, ts, raw: meta.raw || null };
    // emit local event
    this.emit('price', payload);
    // emit to clients if socket.io provided
    if(this.io){
      try{ this.io.emit('price', payload); }catch(e){ console.warn('io emit price error', e); }
    }
  }

  getPrice(symbol){
    return this.prices[symbol] || null;
  }
}

module.exports = PriceHandler;
