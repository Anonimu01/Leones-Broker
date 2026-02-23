// utils/priceHandler.js
import { EventEmitter } from "events";

const priceStore = {}; // { symbol: { price, ts, raw } }

class PriceHandler extends EventEmitter {
  constructor(io = null){
    super();
    this.io = io;
    this.prices = priceStore;
  }

  handlePolygonItem({ cls, item }) {

    if(item.ev === 'T' || item.ev === 't' || item.ev === 'trade'){
      const sym = item.sym || item.ticker || item.S;
      const price = Number(item.p ?? item.price ?? item.last ?? 0);
      const size = Number(item.s ?? item.size ?? 0);
      const ts = item.t || Date.now();

      this._updatePrice(sym, price, ts, { cls, raw: item, type: 'trade', size });
    }

    else if(item.ev === 'Q' || item.ev === 'quote'){
      const sym = item.sym || item.ticker;
      const bid = Number(item.bp ?? item.bid ?? 0);
      const ask = Number(item.ap ?? item.ask ?? 0);
      const ts = item.t || Date.now();
      const mid = (bid && ask) ? ((bid + ask)/2) : (bid || ask || 0);

      this._updatePrice(sym, mid, ts, { cls, raw: item, type:'quote', bid, ask });
    }

    else if(item.ev === 'status'){
      this.emit('status', item);
    }

    else{
      const sym = item.sym || item.ticker || item.S;
      if(sym && (item.p || item.price)){
        this._updatePrice(
          sym,
          Number(item.p || item.price),
          item.t || Date.now(),
          { cls, raw:item, type:'other' }
        );
      } else {
        this.emit('raw_unhandled', { cls, item });
      }
    }
  }

  _updatePrice(symbol, price, ts, meta = {}){
    if(!symbol) return;

    const s = symbol.includes(':')
      ? symbol.split(':').pop()
      : symbol;

    const prev = this.prices[s] || {};

    const payload = {
      symbol: s,
      price,
      ts,
      change: prev.price ? price - prev.price : 0,
      meta
    };

    this.prices[s] = { price, ts, raw: meta.raw || null };

    this.emit('price', payload);

    if(this.io){
      try{
        this.io.emit('price', payload);
      }catch(e){
        console.warn('io emit price error', e);
      }
    }
  }

  getPrice(symbol){
    return this.prices[symbol] || null;
  }
}

export default PriceHandler;
