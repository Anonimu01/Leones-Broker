// public/js/polygon-client.js
// Robust polygon-client for browser. Handles missing libs, fallback, safe fetch parsing,
// socket events, chart updates (LightweightCharts) and graceful stubs when libs missing.

(function () {
  "use strict";

  // ---------- safe globals / env detection ----------
  const API_BASE = (function(){
    // prefer explicit globals set by your HTML
    if (typeof window.API_BASE === 'string' && window.API_BASE.trim()) return window.API_BASE.replace(/\/+$/,'');
    if (typeof window.API === 'string' && window.API.trim()) {
      // window.API might be "https://example.com/api" or "https://example.com/api/"
      return String(window.API).replace(/\/+$/,'');
    }
    // fallback sensible defaults
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
      return "http://localhost:3000/api";
    }
    // derive from origin: ensure ends with /api
    const origin = location.origin.replace(/\/+$/,'');
    return origin + "/api";
  })();

  const SOCKET_URL = (function(){
    try {
      const candidate = String(API_BASE).replace(/\/api\/?$/,'');
      return candidate || location.origin;
    } catch (e) { return location.origin; }
  })();

  const log = (...a)=>{ try{ console.log.apply(console,a);}catch(e){} };
  const warn = (...a)=>{ try{ console.warn.apply(console,a);}catch(e){} };
  const err = (...a)=>{ try{ console.error.apply(console,a);}catch(e){} };

  log("polygon-client.js initialized", { API_BASE, SOCKET_URL });

  // ---------- safe fetch JSON ----------
  async function safeFetchJson(url, opts){
    try{
      const r = await fetch(url, opts);
      const text = await r.text().catch(()=>null);
      let data = null;
      try{ data = text ? JSON.parse(text) : null; }catch(e){ data = text; }
      if(!r.ok){
        const eObj = new Error('HTTP '+r.status);
        eObj.status = r.status; eObj.body = data;
        throw eObj;
      }
      return data;
    }catch(e){
      throw e;
    }
  }

  // ---------- symbols fallback ----------
  window.ALL_SYMBOLS = window.ALL_SYMBOLS || [
    { symbol: "BINANCE:BTCUSDT", label: "BTC/USDT", market: "Crypto" },
    { symbol: "BINANCE:ETHUSDT", label: "ETH/USDT", market: "Crypto" },
    { symbol: "OANDA:EUR_USD", label: "EUR/USD", market: "Forex" },
    { symbol: "NASDAQ:AAPL", label: "AAPL", market: "Stocks" }
  ];

  async function loadSymbolsFromServer(){
    const paths = [
      `${API_BASE.replace(/\/+$/,'')}/symbols`,
      `${API_BASE.replace(/\/+$/,'')}/api/symbols`,
      `/api/symbols`,
      `${API_BASE.replace(/\/+$/,'')}/market/symbols`,
      `${API_BASE.replace(/\/+$/,'')}/markets/symbols`,
      `${API_BASE.replace(/\/+$/,'')}/api/markets/symbols`,
      `${API_BASE.replace(/\/+$/,'')}/api/market/list`
    ];
    for(const p of paths){
      try{
        const res = await safeFetchJson(p, { method:'GET' });
        if(!res) continue;
        // normalize array or object map
        if(Array.isArray(res) && res.length>0){
          const arr = res.map(it=>{
            if(typeof it === 'string') return { symbol: it, label: it, market: 'Unknown' };
            return { symbol: it.symbol || it.s || it.sym || it.t || '', label: it.label || it.name || it.symbol || it.t || '', market: it.market || it.exchange || it.mkt || 'Unknown' };
          }).filter(x=>x.symbol && x.label);
          if(arr.length){ window.ALL_SYMBOLS = arr; log('Symbols loaded from',p,'count=',arr.length); return window.ALL_SYMBOLS; }
        } else if(typeof res === 'object' && Object.keys(res).length){
          // object map -> convert
          const arr = [];
          Object.keys(res).forEach(k=>{
            const it = res[k];
            if(it && (it.symbol || it.label || it.name)) arr.push({ symbol: it.symbol || k, label: it.label || it.name || k, market: it.market || 'Unknown' });
            else arr.push({ symbol: k, label: k, market: 'Unknown' });
          });
          window.ALL_SYMBOLS = arr;
          log('Symbols loaded (object) from',p,'count=',arr.length);
          return window.ALL_SYMBOLS;
        }
      }catch(e){
        // ignore and continue
      }
    }
    log('Symbols fallback used, count=', window.ALL_SYMBOLS.length);
    return window.ALL_SYMBOLS;
  }

  // ---------- chart integration (LightweightCharts) ----------
  let chart = null;
  let chartSeries = null;
  const chartContainerId = 'tv_chart_container';

  function initChartIfAvailable(){
    const cont = document.getElementById(chartContainerId);
    if(!cont){
      // no container, nothing to do
      return false;
    }
    if(typeof LightweightCharts === 'undefined'){
      warn('LightweightCharts not found — chart disabled');
      return false;
    }

    try{
      // try to remove old chart if possible
      try{ if(chart && typeof chart.remove === 'function') chart.remove(); }catch(e){}

      chart = LightweightCharts.createChart(cont, {
        width: cont.clientWidth || 800,
        height: Math.max(320, cont.clientHeight || 420),
        layout: { backgroundColor:'#0b0b0b', textColor:'#d1d1d1' },
        grid: { vertLines:{ color:'rgba(255,255,255,0.03)' }, horzLines:{ color:'rgba(255,255,255,0.03)' } },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
        timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible:true, secondsVisible:true }
      });

      // compatibility: try addLineSeries, else addAreaSeries, else addSeries
      if(typeof chart.addLineSeries === 'function'){
        chartSeries = chart.addLineSeries({ color:'#f1c40f', priceLineVisible:true });
      } else if(typeof chart.addAreaSeries === 'function'){
        chartSeries = chart.addAreaSeries({ topColor:'rgba(241,196,15,0.12)', bottomColor:'rgba(241,196,15,0.02)', lineColor:'#f1c40f' });
      } else if(typeof chart.addSeries === 'function'){
        try{
          // some builds expose addSeries with constructor param
          chartSeries = chart.addSeries(LightweightCharts.LineStyle ? LightweightCharts.LineStyle : undefined);
        }catch(e){
          // last resort: not supported
          chartSeries = null;
        }
      } else {
        chartSeries = null;
      }

      // safety: if no series then chart is partially supported but keep running
      if(!chartSeries) warn('Chart initialized but no series created (incompatible API)');

      // responsive
      window.addEventListener('resize', ()=> {
        try{ chart.applyOptions({ width: cont.clientWidth }); }catch(e){}
      });

      log('LightweightCharts initialized (chartSeries ok=' + !!chartSeries + ')');
      return !!chartSeries;
    }catch(e){
      warn('Error initializing LightweightCharts:', e);
      return false;
    }
  }

  function toUnixSeconds(ts){
    if(!ts) return Math.floor(Date.now()/1000);
    const s = Number(ts);
    if(String(s).length > 12) return Math.floor(s/1000);
    return Math.floor(s);
  }

  function setChartPointForSymbol(symbol, priceObj){
    if(!chartSeries || !priceObj) return;
    try{
      const time = toUnixSeconds(priceObj.ts || priceObj.time || priceObj.t);
      chartSeries.update({ time: time, value: Number(priceObj.price ?? priceObj) });
    }catch(e){
      try{
        // try setData fallback (single point)
        const time = toUnixSeconds(priceObj.ts || priceObj.time || priceObj.t);
        chartSeries.setData([{ time: time, value: Number(priceObj.price ?? priceObj) }]);
      }catch(e2){}
    }
  }

  // ---------- small price label updater ----------
  function formatPriceForLabel(v){
    const n = Number(v);
    if(!isFinite(n)) return '--';
    if(Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
    if(Math.abs(n) >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
    return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
  }

  function updateSmallPriceLabels(symbol, valueOrObj){
    try{
      const price = (valueOrObj && typeof valueOrObj === 'object') ? (valueOrObj.price ?? valueOrObj.p ?? valueOrObj.v ?? valueOrObj) : valueOrObj;
      const nodes = Array.from(document.querySelectorAll(`[data-symbol="${symbol}"], #op-price, .price[data-symbol="${symbol}"]`));
      const text = formatPriceForLabel(price);
      nodes.forEach(n => { n.textContent = text; });
    }catch(e){}
  }

  // ---------- centralized price storage & handler ----------
  window.symbolPrices = window.symbolPrices || {}; // map symbol -> { price, ts, market? }

  function normalizeSnapshotItem(key, it){
    // returns { symbol, price, ts, market? }
    if(!it) return null;
    if(typeof it === 'number' || typeof it === 'string') return { symbol: key, price: Number(it), ts: Date.now() };
    const symbol = it.symbol || it.s || key;
    const price = Number(it.price ?? it.p ?? it.v ?? it.last ?? it);
    const ts = it.ts ?? it.t ?? Date.now();
    const market = it.market || it.mkt || undefined;
    if(!symbol) return null;
    return { symbol, price, ts, market };
  }

  const priceHandler = {
    applySnapshot(snapshot){
      try{
        if(!snapshot) return;
        // shape: array [{symbol, price, ts}] or object { SYMBOL: {...} }
        if(Array.isArray(snapshot)){
          snapshot.forEach(item=>{
            const it = normalizeSnapshotItem(item.symbol || item.s || item.t || '', item);
            if(it){
              window.symbolPrices[it.symbol] = { price: it.price, ts: it.ts, market: it.market };
              updateSmallPriceLabels(it.symbol, { price: it.price });
            }
          });
        } else if(typeof snapshot === 'object'){
          // could be map of symbol->value or symbol->meta
          Object.keys(snapshot).forEach(k=>{
            const raw = snapshot[k];
            const it = normalizeSnapshotItem(k, raw);
            if(it){
              window.symbolPrices[it.symbol] = { price: it.price, ts: it.ts, market: it.market };
              updateSmallPriceLabels(it.symbol, { price: it.price });
            }
          });
        }
        // attempt to seed chart with currently shown symbol
        const curEl = document.getElementById('tradingSymbol');
        const cur = curEl && curEl.innerText ? curEl.innerText.replace('/','') : null;
        if(cur && window.symbolPrices[cur]){
          setChartPointForSymbol(cur, { price: window.symbolPrices[cur].price, ts: window.symbolPrices[cur].ts });
        }
      }catch(e){ warn('applySnapshot error', e); }
    },
    applyTick(tick){
      try{
        if(!tick) return;
        const symbol = tick.symbol || tick.s || tick.t || tick.sym;
        if(!symbol) return;
        const price = Number(tick.price ?? tick.p ?? tick.v ?? tick.last ?? tick);
        const ts = tick.ts ?? tick.t ?? Date.now();
        window.symbolPrices[symbol] = { price, ts, market: tick.market || tick.mkt || window.symbolPrices[symbol]?.market };
        updateSmallPriceLabels(symbol, { price, ts });
        // if chart active and matches current label, push
        const curEl = document.getElementById('tradingSymbol');
        const cur = curEl && curEl.innerText ? curEl.innerText.replace('/','') : null;
        if(chart && chartSeries && cur && (symbol === cur || symbol.endsWith(cur))){
          setChartPointForSymbol(symbol, { price, ts });
        }
      }catch(e){ warn('applyTick error', e); }
    }
  };

  // ---------- socket initialization ----------
  let socket = null;
  const hasIO = (typeof io === 'function');
  if(hasIO){
    try{
      socket = io(SOCKET_URL, {
        path: '/socket.io',
        transports: ['websocket','polling'],
        withCredentials: true,
        reconnection: true,
        reconnectionAttempts: Infinity,
        timeout: 20000,
      });

      socket.on('connect', ()=>{ log('socket connected', socket.id); socket.emit('request_prices_snapshot'); socket.emit('request_symbols'); });
      socket.on('disconnect', (r)=>{ warn('socket disconnected', r); });
      socket.on('connect_error', e=>{ warn('socket connect_error', e && e.message ? e.message : e); });

      socket.on('prices_snapshot', snap => {
        log('prices_snapshot', (snap && (Array.isArray(snap) ? snap.length : Object.keys(snap||{}).length)) || snap);
        try{ priceHandler.applySnapshot(snap); }catch(e){ warn('prices_snapshot handler failed', e); }
      });

      socket.on('price', p => {
        try{ priceHandler.applyTick(p); }catch(e){ warn('price handler error', e); }
      });

      socket.on('symbols_update', syms => {
        try{
          if(Array.isArray(syms) && syms.length){
            window.ALL_SYMBOLS = syms.map(s => ({ symbol: s.symbol||s.sym||s.t||'', label: s.label||s.name||s.symbol||'', market: s.market||s.mkt||'Unknown' })).filter(x=>x.symbol);
            log('symbols_update received count=', window.ALL_SYMBOLS.length);
          }
        }catch(e){ warn('symbols_update parse', e); }
      });

    }catch(e){
      warn('socket init failed', e);
      socket = null;
    }
  } else {
    warn('socket.io client not found — realtime disabled');
  }

  // stub subscribe/unsubscribe so other code doesn't crash
  window.subscribeSymbol = window.subscribeSymbol || function(symbol, kind='trades'){ if(!symbol) return; if(!socket){ warn('subscribeSymbol: socket not available'); return; } socket.emit('subscribe',{ symbol, kind }); };
  window.unsubscribeSymbol = window.unsubscribeSymbol || function(symbol, kind='trades'){ if(!symbol) return; if(!socket){ warn('unsubscribeSymbol: socket not available'); return; } socket.emit('unsubscribe',{ symbol, kind }); };

  // orderbook / display helpers
  window.updateOrderBook = window.updateOrderBook || function(ob){
    try{
      const bids = document.getElementById('ob-bids'); const asks = document.getElementById('ob-asks');
      if(!bids || !asks) return;
      const p = Number(ob && ob.mid) || Number(window.symbolPrices[Object.keys(window.symbolPrices||{})[0]]?.price) || 0;
      bids.innerHTML = Array.from({length:6}).map((_,i)=>`${(p - (i+1)*(p*0.001||0.001)).toFixed(6)} • ${Math.floor(Math.random()*10)}`).join('<br/>');
      asks.innerHTML = Array.from({length:6}).map((_,i)=>`${(p + (i+1)*(p*0.001||0.001)).toFixed(6)} • ${Math.floor(Math.random()*10)}`).join('<br/>');
    }catch(e){}
  };

  window.updateDisplayedPrice = window.updateDisplayedPrice || function(price){
    try{
      const el = document.getElementById('op-price');
      if(el) el.textContent = formatPriceForLabel(price);
    }catch(e){}
  };

  // ---------- boot sequence ----------
  (async function boot(){
    try{
      await loadSymbolsFromServer();
    }catch(e){ warn('loadSymbolsFromServer failed', e); }

    const chartOk = initChartIfAvailable();

    // populate any existing symbolPrices into DOM
    try{ Object.keys(window.symbolPrices||{}).forEach(k=> updateSmallPriceLabels(k, window.symbolPrices[k])); }catch(e){}

    // demo fallback if no socket connected — keep light
    if(!socket){
      log('No socket: starting light demo updater (non intrusive)');
      setInterval(()=> {
        try{
          (window.ALL_SYMBOLS || []).forEach(s=>{
            const key = s.symbol;
            const old = Number(window.symbolPrices[key]?.price) || (Math.random()*100);
            const change = (Math.random()-0.5) * Math.max(0.0001, Math.abs(old)*0.002);
            const next = Math.max(0.00001, old + change);
            window.symbolPrices[key] = { price: next, ts: Date.now(), market: s.market || 'Unknown' };
            updateSmallPriceLabels(key, { price: next, ts: Date.now() });
            // update chart if matches
            const curEl = document.getElementById('tradingSymbol');
            const cur = curEl && curEl.innerText ? curEl.innerText.replace('/','') : null;
            if(chartOk && cur && (key === cur || key.endsWith(cur))){
              setChartPointForSymbol(key, { price: next, ts: Date.now() });
            }
          });
        }catch(e){}
      }, 1200);
    }

    log('polygon-client boot complete');
  })();

})();
