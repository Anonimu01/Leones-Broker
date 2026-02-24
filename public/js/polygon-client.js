// public/js/polygon-client.js
// Robust polygon-client for browser. Handles missing libs, fallback, safe fetch parsing,
// socket events, chart updates (LightweightCharts) and graceful stubs when libs missing.

(function () {
  "use strict";

  console.log("polygon-client.js initialized");

  // safe global API root
  const API_ROOT = (window.API && String(window.API).replace(/\/+$/, "")) || "";

  // safe console wrapper
  function log(...args) { try { console.log.apply(console, args); } catch (e) {} }
  function warn(...args) { try { console.warn.apply(console, args); } catch (e) {} }
  function err(...args) { try { console.error.apply(console, args); } catch (e) {} }

  // --------- socket initialization (safe) ----------
  let socket = null;
  const hasIO = (typeof io === "function");
  if (!hasIO) {
    warn("socket.io client (io) no está disponible — realtime inactivo.");
  } else {
    try {
      // configure reconnection options as you like
      socket = io(undefined, {
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000,
      });

      socket.on("connect", () => {
        log("socket connected", socket.id);
      });

      socket.on("connect_error", (err) => {
        warn("socket connect_error", err && err.message ? err.message : err);
      });

      socket.on("disconnect", (reason) => {
        warn("socket disconnected", reason);
      });
    } catch (e) {
      err("Error initializing socket.io:", e);
      socket = null;
    }
  }

  // --------- safe fetch utility (avoids Unexpected token '<') ----------
  async function safeFetchJson(url, opts) {
    try {
      const r = await fetch(url, opts);
      const text = await r.text().catch(() => null);
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        // not JSON
        data = text;
      }
      if (!r.ok) {
        throw { status: r.status, body: data };
      }
      return data;
    } catch (e) {
      throw e;
    }
  }

  // --------- symbol list (try server, fallback) ----------
  window.ALL_SYMBOLS = window.ALL_SYMBOLS || [
    { symbol: "BINANCE:BTCUSDT", label: "BTC/USDT", market: "Crypto" },
    { symbol: "BINANCE:ETHUSDT", label: "ETH/USDT", market: "Crypto" },
    { symbol: "OANDA:EUR_USD", label: "EUR/USD", market: "Forex" },
    { symbol: "NASDAQ:AAPL", label: "AAPL", market: "Stocks" },
  ];

  async function loadSymbolsFromServer() {
    const candidates = [];
    // try several sensible paths
    const paths = [
      `${API_ROOT}/api/symbols`,
      `/api/symbols`,
      `${API_ROOT}/api/markets/symbols`,
      `${API_ROOT}/api/market/symbols`,
      `${API_ROOT}/api/market/list`,
    ];
    for (const p of paths) {
      try {
        const res = await safeFetchJson(p, { method: "GET" });
        if (Array.isArray(res) && res.length > 0) {
          window.ALL_SYMBOLS = res.map((it) => {
            return {
              symbol: it.symbol || it.sym || it.t || "",
              label: it.label || it.name || it.symbol || it.sym || "",
              market: it.market || it.exchange || it.cat || "Crypto",
            };
          }).filter(x => x.symbol && x.label);
          log("Symbols loaded from", p, "count=", window.ALL_SYMBOLS.length);
          return window.ALL_SYMBOLS;
        }
      } catch (e) {
        // ignore and try next
        // console.debug("symbols load fail", p, e);
      }
    }
    log("Symbols using fallback list, count=", window.ALL_SYMBOLS.length);
    return window.ALL_SYMBOLS;
  }

  // --------- lightweight chart integration (optional) ----------
  let chart = null;
  let chartSeries = null;
  const chartContainerId = "tv_chart_container";

  function initChartIfAvailable() {
    const container = document.getElementById(chartContainerId);
    if (!container) {
      // no container in DOM
      return false;
    }
    if (typeof LightweightCharts === "undefined") {
      warn("LightweightCharts no disponible — gráfico inactivo.");
      return false;
    }
    try {
      // cleanup if exists
      try { if (chart) chart.remove(); } catch (e) {}
      chart = LightweightCharts.createChart(container, {
        width: container.clientWidth,
        height: Math.max(320, container.clientHeight || 420),
        layout: { backgroundColor: "#0b0b0b", textColor: "#d1d1d1" },
        grid: { vertLines: { color: "rgba(255,255,255,0.03)" }, horzLines: { color: "rgba(255,255,255,0.03)" } },
        rightPriceScale: { visible: true },
        timeScale: { timeVisible: true, secondsVisible: true },
      });
      chartSeries = chart.addLineSeries({ color: "#f1c40f", priceLineVisible: true });
      // responsive
      window.addEventListener("resize", () => {
        try { chart.applyOptions({ width: container.clientWidth }); } catch (e) {}
      });
      log("LightweightCharts inicializado");
      return true;
    } catch (e) {
      warn("Error iniciando LightweightCharts:", e);
      return false;
    }
  }

  function setChartPointForSymbol(symbol, priceObj) {
    if (!chartSeries || !priceObj) return;
    // priceObj expected shape: { price: Number, ts: epochMillis OR ts: epochSec }
    let t = priceObj.ts || priceObj.time || Date.now();
    if (String(t).length > 12) t = Math.floor(Number(t) / 1000); // to seconds
    try {
      chartSeries.update({ time: Math.floor(Number(t)), value: Number(priceObj.price) });
    } catch (e) {
      // sometimes update fails if series not ready; try setData small
      try { chartSeries.setData([{ time: Math.floor(Number(t)), value: Number(priceObj.price) }]); } catch (e2) {}
    }
  }

  // --------- DOM updates for small price labels ----------
  function updateSmallPriceLabels(symbol, price) {
    try {
      const sel = `[data-symbol="${symbol}"], #op-price, .price[data-symbol="${symbol}"]`;
      const els = Array.from(document.querySelectorAll(sel));
      els.forEach((el) => {
        if (!el) return;
        const formatted = (Number(price) >= 1000) ? Number(price).toLocaleString(undefined, { maximumFractionDigits: 1 }) : Number(price).toLocaleString(undefined, { maximumFractionDigits: 6 });
        el.textContent = formatted;
      });
    } catch (e) { /* ignore */ }
  }

  // --------- price handling (central) ----------
  window.symbolPrices = window.symbolPrices || {}; // latest prices map

  const priceHandler = {
    applySnapshot(snapshot) {
      try {
        if (!snapshot || typeof snapshot !== "object") return;
        window.symbolPrices = Object.assign(window.symbolPrices || {}, snapshot);
        // if chart present, set an initial point for current symbol
        const currentLabelEl = document.getElementById("tradingSymbol");
        const currentLabel = currentLabelEl && currentLabelEl.innerText ? currentLabelEl.innerText.replace("/", "") : null;
        if (currentLabel && snapshot[currentLabel]) {
          setChartPointForSymbol(currentLabel, snapshot[currentLabel]);
          updateSmallPriceLabels(currentLabel, snapshot[currentLabel].price || snapshot[currentLabel]);
        }
      } catch (e) {
        warn("applySnapshot error", e);
      }
    },

    applyTick(tick) {
      try {
        if (!tick || !tick.symbol) return;
        const symbol = tick.symbol;
        const price = typeof tick.price !== "undefined" ? tick.price : tick.p || tick.last || tick.l;
        const ts = tick.ts || tick.t || Date.now();
        window.symbolPrices[symbol] = price;
        updateSmallPriceLabels(symbol, price);

        // if chart present and currentSymbol matches, update series
        const currentLabelEl = document.getElementById("tradingSymbol");
        const currentLabel = currentLabelEl && currentLabelEl.innerText ? (currentLabelEl.innerText.replace("/", "") ) : null;
        if (chartSeries && currentLabel && (symbol.endsWith(currentLabel) || symbol === currentLabel)) {
          setChartPointForSymbol(symbol, { price, ts });
        }
      } catch (e) {
        warn("applyTick error", e);
      }
    }
  };

  // --------- socket event wiring ----------
  if (socket) {
    socket.on("prices_snapshot", (snapshot) => {
      log("prices_snapshot", snapshot && Object.keys(snapshot).length ? `count=${Object.keys(snapshot).length}` : snapshot);
      try { priceHandler.applySnapshot(snapshot || {}); } catch (e) {}
    });

    socket.on("price", (p) => {
      try { priceHandler.applyTick(p); } catch (e) {}
    });
  } else {
    // stub: create no-op socket methods so other scripts calling subscribeSymbol don't crash
    log("Socket not available: creating stubs for subscribeSymbol/unsubscribeSymbol");
  }

  // expose globals for other scripts
  window.subscribeSymbol = window.subscribeSymbol || function (symbol, kind = "trades") {
    if (!symbol) return;
    if (!socket) { warn("subscribeSymbol: socket not available"); return; }
    socket.emit("subscribe", { symbol, kind });
  };

  window.unsubscribeSymbol = window.unsubscribeSymbol || function (symbol, kind = "trades") {
    if (!symbol) return;
    if (!socket) { warn("unsubscribeSymbol: socket not available"); return; }
    socket.emit("unsubscribe", { symbol, kind });
  };

  // --------- orderbook / price display stubs (extend in your app) ----------
  window.updateOrderBook = window.updateOrderBook || function (price) {
    // simple demo: update ob-bids/ob-asks elements with near-price values
    try {
      const bids = document.getElementById("ob-bids");
      const asks = document.getElementById("ob-asks");
      if (!bids || !asks) return;
      const p = Number(price) || 0;
      const bidsHtml = Array.from({ length: 6 }).map((_, i) => `${(p - (i + 1) * (p * 0.001 || 0.001)).toFixed(6)} · ${Math.floor(Math.random() * 10)}`).join("<br>");
      const asksHtml = Array.from({ length: 6 }).map((_, i) => `${(p + (i + 1) * (p * 0.001 || 0.001)).toFixed(6)} · ${Math.floor(Math.random() * 10)}`).join("<br>");
      bids.innerHTML = bidsHtml;
      asks.innerHTML = asksHtml;
    } catch (e) {}
  };

  window.updateDisplayedPrice = window.updateDisplayedPrice || function (price) {
    try {
      const opPrice = document.getElementById("op-price");
      if (opPrice) {
        opPrice.textContent = (Number(price) >= 1000) ? Number(price).toLocaleString(undefined, { maximumFractionDigits: 1 }) : Number(price).toLocaleString(undefined, { maximumFractionDigits: 6 });
      }
    } catch (e) {}
  };

  // --------- load symbols, init chart, and wire demo engine fallback ----------
  (async function boot() {
    try {
      await loadSymbolsFromServer();
    } catch (e) {
      warn("loadSymbolsFromServer error", e);
    }

    // init chart if available
    const chartOk = initChartIfAvailable();

    // if no realtime socket but we have symbolPrices data, populate small labels
    try {
      Object.keys(window.symbolPrices || {}).forEach(sym => {
        updateSmallPriceLabels(sym, window.symbolPrices[sym]);
      });
    } catch (e) {}

    // If no socket present, keep a safe demo updater so page isn't empty (but not heavy)
    if (!socket) {
      setInterval(() => {
        // slight random walk on ALL_SYMBOLS
        (window.ALL_SYMBOLS || []).forEach(s => {
          const key = s.symbol;
          const old = Number(window.symbolPrices[key]) || (Math.random() * 100);
          const change = (Math.random() - 0.5) * (Math.max(0.0001, Math.abs(old) * 0.002));
          const next = Math.max(0.00001, old + change);
          window.symbolPrices[key] = next;
          updateSmallPriceLabels(key, next);
          // if chart is active and current matches, update
          const currentLabelEl = document.getElementById("tradingSymbol");
          const currentLabel = currentLabelEl && currentLabelEl.innerText ? currentLabelEl.innerText.replace("/", "") : null;
          if (chartOk && currentLabel && (key.endsWith(currentLabel) || key === currentLabel)) {
            setChartPointForSymbol(key, { price: next, ts: Date.now() });
          }
        });
      }, 1200);
    }

    log("polygon-client boot complete");
  })();

})();
