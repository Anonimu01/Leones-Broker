// sockets/polygonSocket.js
import WebSocket from "ws";
import EventEmitter from "events";
import { endpoints, key, prefixes } from "../config/polygon.js";

class PolygonSocket extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.apiKey = opts.apiKey || key;

    this.classmap = opts.classmap || {
      crypto: ["BINANCE","COINBASE","CRYPTO"],
      forex: ["OANDA","FX"],
      stocks: ["NASDAQ","NYSE","AMEX","INDEX","SPX"]
    };

    this.ws = {};
    this.subscriptions = {
      stocks: new Set(),
      crypto: new Set(),
      forex: new Set()
    };

    this.reconnectDelay = 3000;
    this._connecting = { stocks:false, crypto:false, forex:false };
  }

  _guessClass(symbol){
    if(!symbol) return "stocks";
    const s = symbol.toUpperCase();

    if(s.includes("BTC") || s.includes("ETH") || s.includes("CRYPTO"))
      return "crypto";

    if(s.includes("/") || s.includes("FX") || s.includes("OANDA"))
      return "forex";

    return "stocks";
  }

  async start(){
    ["stocks","crypto","forex"].forEach(cls=>{
      if(!this.ws[cls]) this._connectClass(cls);
    });
  }

  _connectClass(cls){
    if(this._connecting[cls]) return;
    this._connecting[cls] = true;

    const url = endpoints[cls];
    if(!url){
      console.warn("Polygon endpoint missing for", cls);
      return;
    }

    const conn = new WebSocket(url);
    this.ws[cls] = conn;

    conn.on("open", ()=>{
      this._connecting[cls] = false;
      this.emit("status",{ cls, status:"connected" });

      try{
        conn.send(JSON.stringify({ action:"auth", params:this.apiKey }));
      }catch(e){
        console.error("auth send error", e);
      }

      const params = Array.from(this.subscriptions[cls] || []).join(",");
      if(params){
        conn.send(JSON.stringify({ action:"subscribe", params }));
      }
    });

    conn.on("message",(msg)=>{
      try{
        const data = JSON.parse(msg.toString());

        this.emit("raw",{ cls, data });

        data.forEach(item=>{
          if(item.ev === "status"){
            this.emit("status",{ cls, status:item.status, message:item.message });
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
      setTimeout(()=>this._connectClass(cls), this.reconnectDelay);
    });

    conn.on("error",(err)=>{
      this.emit("status",{ cls, status:"error", error:String(err) });
      try{ conn.close(); }catch{}
      this.ws[cls] = null;
      setTimeout(()=>this._connectClass(cls), this.reconnectDelay);
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
        kind === "quotes"
          ? "quotes"
          : kind === "aggs"
          ? "aggs"
          : "trades"
      ];

    const subStr = `${prefix}${symbol}`;
    const cls = this._ensureConnFor(symbol);

    if(this.subscriptions[cls].has(subStr)) return;

    this.subscriptions[cls].add(subStr);

    const conn = this.ws[cls];
    if(conn && conn.readyState === WebSocket.OPEN){
      try{
        conn.send(JSON.stringify({ action:"subscribe", params:subStr }));
      }catch(e){
        console.error("subscribe send error", e);
      }
    }
  }

  unsubscribe(symbol, kind="trades"){
    const prefix =
      prefixes[
        kind === "quotes"
          ? "quotes"
          : kind === "aggs"
          ? "aggs"
          : "trades"
      ];

    const subStr = `${prefix}${symbol}`;
    const cls = this._guessClass(symbol);

    if(this.subscriptions[cls].has(subStr)){
      this.subscriptions[cls].delete(subStr);

      const conn = this.ws[cls];
      if(conn && conn.readyState === WebSocket.OPEN){
        try{
          conn.send(JSON.stringify({ action:"unsubscribe", params:subStr }));
        }catch(e){
          console.error("unsubscribe send error", e);
        }
      }
    }
  }

  listSubscriptions(){
    return {
      stocks: Array.from(this.subscriptions.stocks),
      crypto: Array.from(this.subscriptions.crypto),
      forex: Array.from(this.subscriptions.forex)
    };
  }
}

export default PolygonSocket;
