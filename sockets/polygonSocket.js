// sockets/polygonSocket.js
const WebSocket = require('ws');
const EventEmitter = require('events');
const { endpoints, key, prefixes } = require('../config/polygon');

class PolygonSocket extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.apiKey = opts.apiKey || key;
    this.classmap = opts.classmap || { // decide por símbolo dónde conectarlo (simple heuristics)
      crypto: ['BINANCE', 'COINBASE', 'COINBASE_PRO', 'FTX', 'COINBASE', 'CRYPTO'],
      forex: ['OANDA', 'FX'],
      stocks: ['NASDAQ','NYSE','AMEX','INDEX','SPX']
    };
    this.ws = {}; // ws per class (stocks/crypto/forex)
    this.subscriptions = { stocks: new Set(), crypto: new Set(), forex: new Set() };
    this.reconnectDelay = 3000;
    this._connecting = { stocks:false, crypto:false, forex:false };
  }

  // determine class endpoint for symbol (simple rule: prefix strings)
  _guessClass(symbol) {
    if(!symbol) return 'stocks';
    const s = symbol.toUpperCase();
    if(s.includes('BTC') || s.includes('USD') && s.includes('BINANCE')) return 'crypto';
    if(s.includes('OANDA') || s.includes('/')) return 'forex';
    return 'stocks';
  }

  async start() {
    // Start connections for classes we will use (lazy start when subscribing)
    ['stocks','crypto','forex'].forEach(cls=>{
      if(!this.ws[cls]) this._connectClass(cls);
    });
  }

  _connectClass(cls){
    if(this._connecting[cls]) return;
    this._connecting[cls] = true;
    const url = endpoints[cls];
    if(!url) return console.warn('Polygon endpoint missing for', cls);

    const conn = new WebSocket(url);
    this.ws[cls] = conn;

    conn.on('open', () => {
      this._connecting[cls] = false;
      this.emit('status', { cls, status: 'connected' });
      // auth
      try {
        conn.send(JSON.stringify({ action: 'auth', params: this.apiKey }));
      } catch(e){ console.error('auth send error', e); }
      // resubscribe existing
      const params = Array.from(this.subscriptions[cls] || []).join(',');
      if(params) {
        conn.send(JSON.stringify({ action: 'subscribe', params }));
      }
    });

    conn.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        // pass raw message upstream
        this.emit('raw', { cls, data });
        // treat status
        data.forEach(item => {
          if(item.ev === 'status') {
            this.emit('status', { cls, status: item.status, message: item.message });
          } else {
            // normalize and re-emit each item
            this.emit('data', { cls, item });
          }
        });
      } catch(e){
        // some messages could be non-array strings
        this.emit('error', e);
      }
    });

    conn.on('close', () => {
      this.emit('status', { cls, status: 'closed' });
      this.ws[cls] = null;
      // reconnect
      setTimeout(()=> this._connectClass(cls), this.reconnectDelay);
    });

    conn.on('error', (err) => {
      this.emit('status', { cls, status: 'error', error: String(err) });
      try{ conn.close(); }catch(e){}
      this.ws[cls] = null;
      setTimeout(()=> this._connectClass(cls), this.reconnectDelay);
    });
  }

  _ensureConnFor(symbol){
    const cls = this._guessClass(symbol);
    if(!this.ws[cls] || this.ws[cls].readyState !== WebSocket.OPEN) {
      this._connectClass(cls);
    }
    return cls;
  }

  subscribe(symbol, kind = 'trades') {
    // kind: 'trades'|'quotes'|'aggs'
    const prefix = prefixes[kind === 'quotes' ? 'quotes' : (kind === 'aggs' ? 'aggs' : 'trades')];
    const subStr = `${prefix}${symbol}`;
    const cls = this._ensureConnFor(symbol);
    if(this.subscriptions[cls].has(subStr)) return;
    this.subscriptions[cls].add(subStr);
    const conn = this.ws[cls];
    if(conn && conn.readyState === WebSocket.OPEN) {
      try { conn.send(JSON.stringify({ action: 'subscribe', params: subStr })); } catch(e){ console.error('subscribe send error', e); }
    }
  }

  unsubscribe(symbol, kind='trades') {
    const prefix = prefixes[kind === 'quotes' ? 'quotes' : (kind === 'aggs' ? 'aggs' : 'trades')];
    const subStr = `${prefix}${symbol}`;
    const cls = this._guessClass(symbol);
    if(this.subscriptions[cls].has(subStr)){
      this.subscriptions[cls].delete(subStr);
      const conn = this.ws[cls];
      if(conn && conn.readyState === WebSocket.OPEN) {
        try { conn.send(JSON.stringify({ action: 'unsubscribe', params: subStr })); } catch(e){ console.error('unsubscribe send error', e); }
      }
    }
  }

  listSubscriptions() {
    return {
      stocks: Array.from(this.subscriptions.stocks),
      crypto: Array.from(this.subscriptions.crypto),
      forex: Array.from(this.subscriptions.forex)
    };
  }
}

module.exports = PolygonSocket;
