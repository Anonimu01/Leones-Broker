import WebSocket from "ws";
import EventEmitter from "events";
import { endpoints, key, prefixes } from "../config/polygon.js";

export default class PolygonSocket extends EventEmitter {

  constructor(opts = {}) {
    super();

    this.apiKey = opts.apiKey || key;

    this.ws = {};

    this.subscriptions = {
      stocks: new Set(),
      crypto: new Set(),
      forex: new Set(),
      indices: new Set(),
      options: new Set()
    };

    this.reconnectDelay = 3000;

    this._connecting = {
      stocks:false,
      crypto:false,
      forex:false,
      indices:false,
      options:false
    };
  }

  connect(){
    return this.start();
  }

  async start(){
    Object.keys(this.subscriptions).forEach(cls=>{
      if(!this.ws[cls]) this._connectClass(cls);
    });
  }

  _guessClass(symbol){
    if(!symbol) return "stocks";

    const s = symbol.toUpperCase();

    if(s.includes("BTC") || s.includes("ETH") || s.includes("USDT"))
      return "crypto";

    if(s.includes("/") || s.includes("FX") || s.includes("OANDA"))
      return "forex";

    if(s.startsWith("I:") || s.includes("INDEX"))
      return "indices";

    if(s.includes("C:") || s.includes("P:") || s.includes("OPT"))
      return "options";

    return "stocks";
  }

  _connectClass(cls){

    if(this._connecting[cls]) return;

    const url = endpoints[cls];
    if(!url){
      console.warn("No endpoint for", cls);
      return;
    }

    this._connecting[cls] = true;

    const conn = new WebSocket(url);
    this.ws[cls] = conn;

    conn.on("open",()=>{

      this._connecting[cls] = false;

      this.emit("status",{ cls, status:"connected" });

      conn.send(JSON.stringify({
        action:"auth",
        params:this.apiKey
      }));

      const params = [...this.subscriptions[cls]].join(",");
      if(params){
        conn.send(JSON.stringify({
          action:"subscribe",
          params
        }));
      }
    });


    conn.on("message",(msg)=>{
      try{

        const data = JSON.parse(msg.toString());

        this.emit("raw",{ cls, data });

        data.forEach(item=>{
          if(item.ev === "status"){
            this.emit("status",{ cls, status:item.status });
          } else {
            this.emit("data",{ cls, item });
          }
        });

      }catch(e){
        this.emit("error", e);
      }
    });


    conn.on("close",()=>{
      this.emit("status",{ cls, status:"closed" });
      this.ws[cls] = null;
      setTimeout(()=> this._connectClass(cls), this.reconnectDelay);
    });


    conn.on("error",(err)=>{
      this.emit("status",{ cls, status:"error", error:String(err) });

      try{ conn.close(); }catch{}

      this.ws[cls] = null;
      setTimeout(()=> this._connectClass(cls), this.reconnectDelay);
    });
  }

  _ensureConnFor(symbol){
    const cls = this._guessClass(symbol);

    if(!this.ws[cls] || this.ws[cls].readyState !== WebSocket.OPEN){
      this._connectClass(cls);
    }

    return cls;
  }

  subscribe(symbol, kind="trades"){

    const prefix =
      prefixes[
        kind==="quotes"
          ? "quotes"
          : kind==="aggs"
          ? "aggs"
          : "trades"
      ];

    const subStr = `${prefix}${symbol}`;

    const cls = this._ensureConnFor(symbol);

    if(this.subscriptions[cls].has(subStr)) return;

    this.subscriptions[cls].add(subStr);

    const conn = this.ws[cls];

    if(conn && conn.readyState === WebSocket.OPEN){
      conn.send(JSON.stringify({
        action:"subscribe",
        params:subStr
      }));
    }
  }


  subscribeMany(symbols=[], kind="trades"){
    symbols.forEach(s=> this.subscribe(s, kind));
  }


  unsubscribe(symbol, kind="trades"){

    const prefix =
      prefixes[
        kind==="quotes"
          ? "quotes"
          : kind==="aggs"
          ? "aggs"
          : "trades"
      ];

    const subStr = `${prefix}${symbol}`;
    const cls = this._guessClass(symbol);

    if(!this.subscriptions[cls].has(subStr)) return;

    this.subscriptions[cls].delete(subStr);

    const conn = this.ws[cls];

    if(conn && conn.readyState === WebSocket.OPEN){
      conn.send(JSON.stringify({
        action:"unsubscribe",
        params:subStr
      }));
    }
  }


  subscribeOverviewMarkets(){

    const overviewSymbols = [

      // STOCKS
      "AAPL","MSFT","NVDA","AMZN","TSLA",

      // CRYPTO
      "BTCUSD","ETHUSD","SOLUSD","BNBUSD",

      // FOREX
      "EUR/USD","GBP/USD","USD/JPY","USD/CAD",

      // INDICES
      "I:SPX","I:DJI","I:NDX",

      // OPTIONS (ejemplos genéricos)
      "O:AAPL240621C00150000",
      "O:TSLA240621P00200000"
    ];

    this.subscribeMany(overviewSymbols,"trades");
  }


  listSubscriptions(){
    const out = {};
    Object.keys(this.subscriptions).forEach(k=>{
      out[k] = [...this.subscriptions[k]];
    });
    return out;
  }
}
