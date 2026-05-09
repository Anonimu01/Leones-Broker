import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { createServer } from "http";
import { Server as IOServer } from "socket.io";
import fs from "fs";

import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import mongoSanitize from "express-mongo-sanitize";
import xss from "xss-clean";
import jwt from "jsonwebtoken";

import { connectDB } from "./config/db.js";
import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import verificationRoutes from "./routes/verification.routes.js";
import walletRoutes from "./routes/wallet.routes.js";
import positionsRoutes from "./routes/positions.routes.js";
import tradeRoutes from "./routes/trade.routes.js";
import accountRoutes from "./routes/account.routes.js";
import { startRiskWatcher } from "./jobs/risk.job.js";

import PolygonSocket from "./sockets/polygonSocket.js";
import PriceHandler from "./utils/priceHandler.js";
import marketRoutesFactory from "./routes/market.routes.js";
import sendEmail from "./utils/sendEmail.js";

import User from "./models/user.model.js";
import Wallet from "./models/wallet.model.js";
import Position from "./models/position.model.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: process.env.NODE_ENV === "production" ? undefined : path.resolve(__dirname, ".env"),
});

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

connectDB();

mongoose.connection.on("connected", () => {
  console.log("✅ MongoDB conectado. DB:", mongoose.connection.name);
  try {
    const intervalMs = Number(process.env.RISK_JOB_INTERVAL_MS) || 30000;
    const alertThreshold = Number(process.env.RISK_ALERT_THRESHOLD) || 30;
    const closeThreshold = Number(process.env.RISK_CLOSE_THRESHOLD) || 15;
    const stopFn = startRiskWatcher({ intervalMs, alertThreshold, closeThreshold });
    if (typeof stopFn === "function") global.stopRiskWatcher = stopFn;
    console.log(`🛡️ Risk watcher iniciado (interval=${intervalMs}ms alert=${alertThreshold}% close=${closeThreshold}%)`);
  } catch (e) {
    console.error("Error iniciando risk watcher:", e);
  }
});

mongoose.connection.on("error", (err) => console.error("❌ Mongo error:", err));
mongoose.connection.on("disconnected", () => console.warn("⚠️ Mongo desconectado"));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(mongoSanitize());
app.use(xss());

const allowedOrigins = new Set(
  [
    process.env.CLIENT_URL,
    process.env.BASE_URL,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:4000",
    "http://127.0.0.1:4000",
    "https://leones-broker.onrender.com",
  ].filter(Boolean)
);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    try {
      const url = new URL(origin);
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return callback(null, true);
    } catch {}
    console.warn("CORS denied for origin:", origin);
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} › ${req.method} ${req.originalUrl}`);
  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS",
});
app.use("/api", limiter);

const httpServer = createServer(app);
const io = new IOServer(httpServer, {
  cors: {
    origin: Array.from(allowedOrigins).length ? Array.from(allowedOrigins) : process.env.CLIENT_URL || "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const priceHandler = new PriceHandler(io);
app.locals.sendEmail = sendEmail;
app.locals.priceHandler = priceHandler;

/* ======================================================
   HELPERS
   ====================================================== */

const openTradeLocks = new Map();
const liveSyncTimers = new Map();
const activeOrders = new Set();

function makeOpenLockKey(userId, symbol, side, qty) {
  return `${String(userId || "")}:${String(symbol || "")}:${String(side || "")}:${String(qty || "")}`;
}

function makeCloseLockKey(userId, positionId) {
  return `close:${String(userId || "")}:${String(positionId || "")}`;
}

function withOpenLock(key, ttlMs = 1500) {
  const now = Date.now();
  const until = openTradeLocks.get(key) || 0;
  if (until > now) return false;

  openTradeLocks.set(key, now + ttlMs);
  const t = setTimeout(() => {
    const current = openTradeLocks.get(key) || 0;
    if (current <= Date.now()) openTradeLocks.delete(key);
  }, ttlMs + 100);
  if (t && typeof t.unref === "function") t.unref();
  return true;
}

function releaseOpenLock(key) {
  openTradeLocks.delete(key);
}

function withActiveOrder(key, ttlMs = 2500) {
  if (activeOrders.has(key)) return false;
  activeOrders.add(key);
  const t = setTimeout(() => activeOrders.delete(key), ttlMs);
  if (t && typeof t.unref === "function") t.unref();
  return true;
}

function releaseActiveOrder(key) {
  activeOrders.delete(key);
}

function normalizeUniversalSymbol(symbol = "") {
  let s = String(symbol || "").toUpperCase().trim().replace(/\s+/g, "");
  if (!s) return "";

  const parts = s.split(":").filter(Boolean);
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    const prev = parts[parts.length - 2] || "";
    if (/^\d+$/.test(last)) {
      s = prev || last;
    } else {
      s = last;
    }
  }

  s = s.replace(/[^A-Z0-9]/g, "");

  if (s === "XAUUSD") return "GOLD";
  if (s === "XAGUSD") return "SILVER";
  if (s === "USOIL") return "OIL";
  if (s === "UKOIL") return "BRENT";

  return s;
}

function normalizeSymbol(symbol = "") {
  return normalizeUniversalSymbol(symbol);
}

function compactSymbol(value = "") {
  return normalizeUniversalSymbol(value);
}

function getMarketHint(symbol = "") {
  const clean = normalizeUniversalSymbol(symbol);
  if (!clean) return "";

  if (clean === "SPX" || clean === "XJO" || clean.includes("SP500") || clean.includes("SNP")) return "index";

  if (
    clean === "GOLD" ||
    clean === "SILVER" ||
    clean === "OIL" ||
    clean === "BRENT" ||
    clean.includes("NATGAS") ||
    clean.includes("COPPER") ||
    clean.includes("CORN") ||
    clean.includes("WHEAT") ||
    clean.includes("SOYBEAN") ||
    clean.includes("PLATINUM") ||
    clean.includes("PALLADIUM")
  ) return "commodity";

  if (
    clean.includes("BTC") ||
    clean.includes("ETH") ||
    clean.includes("SOL") ||
    clean.includes("BNB") ||
    clean.includes("ADA") ||
    clean.includes("XRP") ||
    clean.includes("DOGE") ||
    clean.includes("LTC") ||
    clean.includes("LINK") ||
    clean.includes("AVAX") ||
    clean.includes("MATIC") ||
    clean.includes("USDT") ||
    clean.includes("USDC") ||
    clean.includes("BUSD")
  ) return "crypto";

  if (/^[A-Z]{6}$/.test(clean)) return "forex";
  if (/^[A-Z]{1,6}$/.test(clean)) return "stocks";
  return "stocks";
}

function toPolygonSymbol(value = "") {
  const clean = normalizeUniversalSymbol(value);
  if (!clean) return "";

  if (clean === "SPX") return "I:SPX";
  if (clean === "XJO") return "I:XJO";

  if (/^[A-Z]{3,5}USDT$/.test(clean)) return `X:${clean.slice(0, -4)}USD`;
  if (/^[A-Z]{3,5}USD$/.test(clean) && getMarketHint(clean) === "crypto") return `X:${clean.slice(0, -3)}USD`;

  if (clean === "GOLD" || clean === "SILVER") return `C:${clean === "GOLD" ? "XAUUSD" : "XAGUSD"}`;
  if (/^[A-Z]{6}$/.test(clean) && getMarketHint(clean) === "forex") return `C:${clean}`;

  return clean;
}

function buildSymbolAliases(symbol = "") {
  const base = normalizeUniversalSymbol(symbol);
  if (!base) return [];

  const aliases = new Set([base]);

  if (/^[A-Z]{6}$/.test(base) && getMarketHint(base) === "forex") {
    const a = base.slice(0, 3);
    const b = base.slice(3);
    aliases.add(`${a}_${b}`);
    aliases.add(`${a}/${b}`);
    aliases.add(`C:${base}`);
    aliases.add(`FOREX:${base}`);
    aliases.add(`FX:${base}`);
    aliases.add(`TVC:${base}`);
  }

  if (/^[A-Z]{3,5}USDT$/.test(base)) {
    const sym = base.slice(0, -4);
    aliases.add(`${sym}USD`);
    aliases.add(`X:${sym}USD`);
    aliases.add(`BINANCE:${base}`);
    aliases.add(`BINANCE:${sym}USD`);
    aliases.add(`${sym}/USDT`);
  }

  if (/^[A-Z]{3,5}USD$/.test(base) && getMarketHint(base) === "crypto") {
    const sym = base.slice(0, -3);
    aliases.add(`${sym}USDT`);
    aliases.add(`X:${sym}USD`);
    aliases.add(`BINANCE:${sym}USDT`);
  }

  if (base === "SPX") {
    aliases.add("I:SPX");
    aliases.add("INDEX:SPX");
    aliases.add("^GSPC");
  }

  if (base === "XJO") {
    aliases.add("I:XJO");
    aliases.add("INDEX:XJO");
    aliases.add("ASX:XJO");
    aliases.add("^AXJO");
  }

  if (base === "GOLD") {
    aliases.add("XAUUSD");
    aliases.add("XAU/USD");
  }

  if (base === "SILVER") {
    aliases.add("XAGUSD");
    aliases.add("XAG/USD");
  }

  if (/^[A-Z]{1,6}$/.test(base) && !["SPX", "XJO", "GOLD", "SILVER"].includes(base)) {
    aliases.add(`NASDAQ:${base}`);
    aliases.add(`NYSE:${base}`);
    aliases.add(`TVC:${base}`);
  }

  return [...aliases].filter(Boolean).map((s) => String(s).trim().toUpperCase());
}

function sameMarketSymbol(a = "", b = "") {
  const x = compactSymbol(a);
  const y = compactSymbol(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function findBestPriceMatch(symbol, store = {}) {
  const wanted = buildSymbolAliases(symbol);
  const keys = Object.keys(store || {});

  for (const key of keys) {
    const keyAliases = buildSymbolAliases(key);
    const keyMatch = keyAliases.some((k) => wanted.some((w) => k === w || k.includes(w) || w.includes(k)));
    if (keyMatch) return store[key];
  }

  for (const key of keys) {
    const item = store[key];
    const candidates = [
      key,
      item?.symbol,
      item?.ticker,
      item?.sym,
      item?.tvSymbol,
      item?.instrument,
      item?.marketSymbol,
      item?.asset,
      item?.name,
      item?.label,
    ].filter(Boolean);

    const found = candidates.some((candidate) => {
      const cAliases = buildSymbolAliases(candidate);
      return cAliases.some((c) => wanted.some((w) => c === w || c.includes(w) || w.includes(c)));
    });

    if (found) return item;
  }

  return null;
}

function normalizeSide(value) {
  const s = String(value || "").trim().toUpperCase();
  if (["BUY", "LONG", "BULL", "CALL"].includes(s)) return "BUY";
  if (["SELL", "SHORT", "BEAR", "PUT"].includes(s)) return "SELL";
  return "";
}

function normalizePositionSymbol(body = {}) {
  const raw = String(
    body.symbol ||
    body.tvSymbol ||
    body.selectedSymbol ||
    body.chartSymbol ||
    body.instrument ||
    body.marketSymbol ||
    body.market ||
    body.ticker ||
    body.asset ||
    ""
  ).trim().toUpperCase();

  return normalizeUniversalSymbol(raw);
}

function normalizeQty(body = {}) {
  const n = Number(
    body.qty ??
    body.quantity ??
    body.amount ??
    body.positionSize ??
    body.notional ??
    body.size ??
    body.volume ??
    body.lots ??
    body.contracts ??
    body.units ??
    body.lotSize
  );
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizePrice(body = {}) {
  const raw =
    body.price ??
    body.entryPrice ??
    body.entry_price ??
    body.currentPrice ??
    body.current_price ??
    body.limitPrice ??
    body.limit_price ??
    body.stopPrice ??
    body.stop_price ??
    body.openPrice ??
    body.open_price ??
    body.tvPrice ??
    body.tv_price ??
    body.lastPrice ??
    body.last_price ??
    body.marketPrice ??
    body.market_price ??
    body.quotePrice ??
    body.quote_price ??
    body.executionPrice ??
    body.execution_price ??
    body.ask ??
    body.bid ??
    body.mark ??
    null;

  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getPriceStore() {
  try {
    const raw = priceHandler?.prices;
    if (!raw) return {};
    if (raw instanceof Map) return Object.fromEntries(raw.entries());
    if (typeof raw === "object") return raw;
    return {};
  } catch {
    return {};
  }
}

function formatSymbolLabel(symbol = "") {
  const s = normalizeUniversalSymbol(symbol);
  if (!s) return "";

  if (s === "SPX") return "S&P 500";
  if (s === "XJO") return "XJO";
  if (s === "GOLD") return "XAU/USD";
  if (s === "SILVER") return "XAG/USD";

  if (/^[A-Z]{3,5}USDT$/.test(s)) return `${s.slice(0, -4)}/USDT`;
  if (/^[A-Z]{6}$/.test(s) && getMarketHint(s) === "forex") {
    return `${s.slice(0, 3)}/${s.slice(3)}`;
  }

  return s;
}

function extractQuotePrice(item = {}, depth = 0) {
  if (!item || depth > 2) return null;

  if (typeof item === "number" || typeof item === "string") {
    const n = Number(item);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const direct =
    toNumber(item.price) ??
    toNumber(item.last) ??
    toNumber(item.close) ??
    toNumber(item.value) ??
    toNumber(item.mark) ??
    toNumber(item.mid) ??
    toNumber(item.c) ??
    toNumber(item.p) ??
    toNumber(item.lp);

  if (Number.isFinite(direct) && direct > 0) return direct;

  const ask = toNumber(item.ask ?? item.a);
  const bid = toNumber(item.bid ?? item.b);

  if (Number.isFinite(ask) && Number.isFinite(bid) && ask > 0 && bid > 0) {
    return (ask + bid) / 2;
  }

  const nestedCandidates = [
    item.results,
    item.result,
    item.data,
    item.trade,
    item.quote,
    item.lastTrade,
    item.t,
    item.q,
    item.raw,
    item.items,
    item.payload,
    item.body,
  ].filter(Boolean);

  for (const nested of nestedCandidates) {
    if (Array.isArray(nested)) {
      for (const entry of nested) {
        const px = extractQuotePrice(entry, depth + 1);
        if (Number.isFinite(px) && px > 0) return px;
      }
      continue;
    }

    if (typeof nested === "object") {
      const px = extractQuotePrice(nested, depth + 1);
      if (Number.isFinite(px) && px > 0) return px;
    }
  }

  return null;
}

function normalizeQuote(symbol, item = {}) {
  const cleanSymbol = normalizeUniversalSymbol(symbol);
  const label = item.label || item.name || formatSymbolLabel(cleanSymbol);
  return {
    symbol: cleanSymbol,
    label,
    market: item.market || getMarketHint(cleanSymbol) || "Unknown",
    price: extractQuotePrice(item),
    bid: toNumber(item.bid),
    ask: toNumber(item.ask),
    open: toNumber(item.open),
    high: toNumber(item.high),
    low: toNumber(item.low),
    volume: toNumber(item.volume),
    change: toNumber(item.change),
    changePercent: toNumber(item.changePercent),
    updatedAt: item.updatedAt || item.timestamp || new Date().toISOString(),
    raw: item,
  };
}

const SAMPLE_SYMBOLS = [
  { symbol: "BINANCE:BTCUSDT", label: "BTC/USDT", market: "Crypto" },
  { symbol: "BINANCE:ETHUSDT", label: "ETH/USDT", market: "Crypto" },
  { symbol: "OANDA:EUR_USD", label: "EUR/USD", market: "Forex" },
  { symbol: "NASDAQ:AAPL", label: "AAPL", market: "Stocks" },
  { symbol: "INDEX:SPX", label: "S&P 500", market: "Indices" },
  { symbol: "INDEX:XJO", label: "XJO", market: "Indices" },
  { symbol: "BINANCE:BCHUSDT", label: "BCH/USDT", market: "Crypto" },
  { symbol: "BINANCE:ADAUSDT", label: "ADA/USDT", market: "Crypto" },
  { symbol: "FOREX:USDJPY", label: "USD/JPY", market: "Forex" },
  { symbol: "OANDA:AUDJPY", label: "AUD/JPY", market: "Forex" },
  { symbol: "NASDAQ:AMZN", label: "AMZN", market: "Stocks" },
];

const MARKET_SEEDS = {
  forex: {
    EURUSD: 1.0840,
    USDJPY: 150.25,
    GBPUSD: 1.274,
    AUDUSD: 0.665,
    USDCAD: 1.365,
    USDCHF: 0.901,
    NZDUSD: 0.612,
    EURJPY: 163.1,
    EURGBP: 0.854,
    EURAUD: 1.64,
    GBPJPY: 191.5,
    EURCAD: 1.48,
    AUDJPY: 98.5,
    NZDJPY: 89.2,
  },
  crypto: {
    BTCUSDT: 67200,
    ETHUSDT: 3500,
    SOLUSDT: 145,
    BNBUSDT: 585,
    ADAUSDT: 0.45,
    XRPUSDT: 0.53,
    DOGEUSDT: 0.16,
    BCHUSDT: 380,
    LTCUSDT: 80,
    DOTUSDT: 6.8,
    AVAXUSDT: 35,
    LINKUSDT: 18,
    MATICUSDT: 0.75,
  },
  stocks: {
    AAPL: 190,
    TSLA: 250,
    NVDA: 900,
    MSFT: 420,
    AMZN: 180,
    META: 485,
    GOOGL: 170,
    NFLX: 625,
    AMD: 165,
    SPY: 520,
    QQQ: 460,
    DIA: 390,
    IBM: 185,
    ORCL: 140,
  },
  indices: {
    SPX: 5200,
    NAS100: 18500,
    DJ30: 39000,
    DAX40: 18400,
    FTSE100: 8200,
    NIKKEI225: 38500,
    RUSSELL2000: 2100,
    VIX: 14.5,
    XJO: 7800,
  },
  commodities: {
    GOLD: 2400,
    XAUUSD: 2400,
    SILVER: 29,
    XAGUSD: 29,
    OIL: 78,
    WTI: 78,
    BRENT: 82,
    NATGAS: 2.8,
    COPPER: 4.2,
    CORN: 430,
    WHEAT: 590,
    SOYBEAN: 1180,
    PLATINUM: 980,
    PALLADIUM: 930,
  },
};

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function detectMarket(symbol = "") {
  const s = normalizeUniversalSymbol(symbol);
  if (!s) return "stocks";

  if (
    s === "SPX" ||
    s === "XJO" ||
    s.includes("NAS100") ||
    s.includes("DJ30") ||
    s.includes("DAX40") ||
    s.includes("FTSE100") ||
    s.includes("NIKKEI225") ||
    s.includes("RUSSELL2000") ||
    s.includes("VIX")
  ) return "indices";

  if (
    s === "GOLD" ||
    s === "SILVER" ||
    s === "OIL" ||
    s === "BRENT" ||
    s.includes("NATGAS") ||
    s.includes("COPPER") ||
    s.includes("CORN") ||
    s.includes("WHEAT") ||
    s.includes("SOYBEAN") ||
    s.includes("PLATINUM") ||
    s.includes("PALLADIUM")
  ) return "commodities";

  if (
    s.includes("BTC") ||
    s.includes("ETH") ||
    s.includes("SOL") ||
    s.includes("BNB") ||
    s.includes("ADA") ||
    s.includes("XRP") ||
    s.includes("DOGE") ||
    s.includes("LTC") ||
    s.includes("LINK") ||
    s.includes("AVAX") ||
    s.includes("MATIC") ||
    s.includes("USDT") ||
    s.includes("USDC") ||
    s.includes("BUSD")
  ) return "crypto";

  if (/^[A-Z]{6}$/.test(s)) return "forex";
  if (/^[A-Z]{1,6}$/.test(s)) return "stocks";
  return "stocks";
}

function getRealisticFallbackPrice(symbol = "") {
  const s = normalizeUniversalSymbol(symbol);

  const fxRanges = {
    EURUSD: [1.05, 1.15],
    GBPUSD: [1.2, 1.35],
    AUDUSD: [0.6, 0.75],
    NZDUSD: [0.58, 0.7],
    USDCAD: [1.3, 1.45],
    USDCHF: [0.85, 0.95],
    EURGBP: [0.82, 0.9],
    EURAUD: [1.55, 1.7],
    EURCAD: [1.4, 1.55],
    USDJPY: [140, 160],
    EURJPY: [160, 170],
    GBPJPY: [185, 205],
    AUDJPY: [90, 100],
    NZDJPY: [82, 92],
  };

  if (fxRanges[s]) return randomBetween(fxRanges[s][0], fxRanges[s][1]);
  if (/^[A-Z]{6}$/.test(s) && detectMarket(s) === "forex") return randomBetween(0.5, 2.5);

  const cryptoRanges = {
    BTCUSDT: [60000, 70000],
    ETHUSDT: [2500, 4000],
    SOLUSDT: [100, 200],
    BNBUSDT: [450, 700],
    ADAUSDT: [0.3, 0.8],
    XRPUSDT: [0.4, 0.9],
    DOGEUSDT: [0.08, 0.3],
    BCHUSDT: [250, 500],
    LTCUSDT: [50, 120],
    DOTUSDT: [4, 12],
    AVAXUSDT: [20, 60],
    LINKUSDT: [10, 30],
    MATICUSDT: [0.4, 1.5],
  };

  if (cryptoRanges[s]) return randomBetween(cryptoRanges[s][0], cryptoRanges[s][1]);
  if (s.endsWith("USDT") || (s.endsWith("USD") && detectMarket(s) === "crypto")) return randomBetween(0.01, 5000);

  const stockRanges = {
    AAPL: [180, 220],
    TSLA: [180, 320],
    NVDA: [700, 1100],
    MSFT: [350, 480],
    AMZN: [150, 220],
    META: [350, 600],
    GOOGL: [120, 220],
    NFLX: [450, 750],
    AMD: [100, 220],
    SPY: [450, 560],
    QQQ: [400, 520],
    DIA: [350, 420],
    IBM: [150, 220],
    ORCL: [100, 170],
  };

  if (stockRanges[s]) return randomBetween(stockRanges[s][0], stockRanges[s][1]);
  if (/^[A-Z]{1,6}$/.test(s) && detectMarket(s) === "stocks") return randomBetween(5, 1500);

  const indexRanges = {
    SPX: [5000, 5400],
    NAS100: [17500, 19000],
    DJ30: [38000, 41000],
    DAX40: [17600, 19000],
    FTSE100: [8000, 8500],
    NIKKEI225: [37000, 39500],
    RUSSELL2000: [1900, 2300],
    VIX: [10, 25],
    XJO: [7400, 8200],
  };

  if (indexRanges[s]) return randomBetween(indexRanges[s][0], indexRanges[s][1]);

  const commodityRanges = {
    GOLD: [2200, 2500],
    XAUUSD: [2200, 2500],
    SILVER: [24, 35],
    XAGUSD: [24, 35],
    OIL: [65, 90],
    WTI: [65, 90],
    BRENT: [70, 95],
    NATGAS: [1.5, 4.5],
    COPPER: [3.5, 5.0],
    CORN: [350, 550],
    WHEAT: [500, 750],
    SOYBEAN: [1000, 1400],
    PLATINUM: [850, 1200],
    PALLADIUM: [850, 1200],
  };

  if (commodityRanges[s]) return randomBetween(commodityRanges[s][0], commodityRanges[s][1]);

  return randomBetween(50, 1000);
}

function generateBasePrice(symbol = "") {
  const s = normalizeUniversalSymbol(symbol);

  for (const group of Object.values(MARKET_SEEDS)) {
    if (Number.isFinite(group[s])) return Number(group[s]);
  }

  return getRealisticFallbackPrice(s);
}

function getVolatility(symbol = "") {
  const s = normalizeUniversalSymbol(symbol);
  const market = detectMarket(s);

  switch (market) {
    case "crypto":
      return s.includes("BTC") ? 0.008 : s.includes("ETH") ? 0.01 : 0.012;
    case "forex":
      return s.includes("JPY") ? 0.0018 : 0.0012;
    case "indices":
      return s.includes("VIX") ? 0.02 : 0.004;
    case "commodities":
      return s.includes("OIL") || s.includes("WTI") || s.includes("BRENT") ? 0.008 : 0.005;
    case "stocks":
    default:
      return 0.006;
  }
}

function writePrice(symbol, price, raw = null) {
  const clean = normalizeUniversalSymbol(symbol);
  const numeric = Number(price);

  if (!clean || !Number.isFinite(numeric) || numeric <= 0) return false;

  const payload = {
    symbol: clean,
    price: numeric,
    market: detectMarket(clean),
    updatedAt: new Date().toISOString(),
    raw,
  };

  global.priceCache[clean] = numeric;
  global.priceMeta[clean] = payload;

  try {
    if (priceHandler?.prices instanceof Map) {
      priceHandler.prices.set(clean, payload);
    } else if (priceHandler?.prices && typeof priceHandler.prices === "object") {
      priceHandler.prices[clean] = payload;
    }
  } catch {}

  return true;
}

function seedInitialSymbols() {
  for (const group of Object.values(MARKET_SEEDS)) {
    for (const [sym, px] of Object.entries(group)) {
      writePrice(sym, px, { source: "seed" });
    }
  }
}

global.priceCache = global.priceCache || {};
global.priceMeta = global.priceMeta || {};

global.getFakePrice = (symbol) => {
  const clean = normalizeUniversalSymbol(symbol);
  if (!clean) return null;

  const existing = Number(global.priceCache[clean]);
  if (Number.isFinite(existing) && existing > 0) return existing;

  const base = generateBasePrice(clean);
  writePrice(clean, base, { source: "seed" });
  return base;
};

function forcePriceExists(symbol) {
  const clean = normalizeUniversalSymbol(symbol);
  if (!clean) return null;

  if (!Number.isFinite(global.priceCache[clean]) || global.priceCache[clean] <= 0) {
    global.priceCache[clean] = global.getFakePrice(clean) || getRealisticFallbackPrice(clean);
  }

  return global.priceCache[clean];
}

function getMarketPrice(symbol) {
  const clean = normalizeUniversalSymbol(symbol);
  if (!clean) return null;

  const store = getPriceStore();
  const found = findBestPriceMatch(clean, store);
  const stored = extractQuotePrice(found || {});
  if (Number.isFinite(stored) && stored > 0) return stored;

  const cached = Number(global.priceCache[clean]);
  if (Number.isFinite(cached) && cached > 0) return cached;

  return global.getFakePrice(clean) || getRealisticFallbackPrice(clean);
}

global.getMarketPrice = getMarketPrice;

seedInitialSymbols();

function getCurrentPriceForSymbol(symbol) {
  const targetCompact = compactSymbol(symbol);
  if (!targetCompact) return null;

  const store = getPriceStore();

  for (const [key, item] of Object.entries(store)) {
    const candidates = [
      key,
      item?.symbol,
      item?.label,
      item?.ticker,
      item?.tvSymbol,
      item?.instrument,
      item?.marketSymbol,
      item?.asset,
    ].filter(Boolean);

    const matched = candidates.some((candidate) => {
      const c = compactSymbol(candidate);
      if (!c) return false;
      return c === targetCompact || c.includes(targetCompact) || targetCompact.includes(c) || sameMarketSymbol(c, targetCompact);
    });

    if (!matched) continue;

    const px = extractQuotePrice(item);
    if (Number.isFinite(px) && px > 0) return px;
  }

  return null;
}

function safeStorePrice(symbol, price, rawData = null) {
  const clean = normalizeUniversalSymbol(symbol);
  const numeric = Number(price);

  if (!clean || !Number.isFinite(numeric) || numeric <= 0) return false;

  const payload = {
    symbol: clean,
    price: numeric,
    market: detectMarket(clean),
    updatedAt: new Date().toISOString(),
    raw: rawData || null,
  };

  global.priceCache[clean] = numeric;
  global.priceMeta[clean] = payload;

  try {
    if (priceHandler?.prices instanceof Map) {
      priceHandler.prices.set(clean, payload);
    } else if (priceHandler?.prices && typeof priceHandler.prices === "object") {
      priceHandler.prices[clean] = payload;
    }
  } catch {}

  if (typeof updatePriceStore === "function") {
    try { updatePriceStore(clean, numeric); } catch {}
  }

  return true;
}

async function fetchPolygonLastPrice(symbol) {
  try {
    const clean = normalizeUniversalSymbol(symbol);
    if (!clean || !process.env.POLYGON_API_KEY) return null;

    const polygonSymbol = toPolygonSymbol(clean);
    if (!polygonSymbol) return null;

    const url = `https://api.polygon.io/v2/last/trade/${encodeURIComponent(polygonSymbol)}?apiKey=${encodeURIComponent(process.env.POLYGON_API_KEY)}`;
    const response = await fetch(url);
    const data = await response.json().catch(() => null);

    const price = extractQuotePrice(data);
    if (price && Number.isFinite(price) && price > 0) {
      return { price, raw: data, symbol: clean, polygonSymbol };
    }

    return null;
  } catch {
    return null;
  }
}

async function resolveUniversalPrice(rawSymbol) {
  try {
    const symbol = normalizeUniversalSymbol(rawSymbol);
    if (!symbol) return null;

    forcePriceExists(symbol);

    let price = getCurrentPriceForSymbol(symbol);
    if (!Number.isFinite(price) || price <= 0) {
      const store = getPriceStore();
      const found = findBestPriceMatch(symbol, store);
      price = extractQuotePrice(found || {});
    }

    if (!Number.isFinite(price) || price <= 0) {
      price = Number(global.priceCache?.[symbol]);
    }

    if (!Number.isFinite(price) || price <= 0) {
      price = global.getFakePrice(symbol);
    }

    if (!Number.isFinite(price) || price <= 0) {
      const fallback = await fetchPolygonLastPrice(symbol);
      if (fallback?.price && Number.isFinite(fallback.price) && fallback.price > 0) {
        price = fallback.price;
        safeStorePrice(symbol, price, fallback.raw);
      }
    }

    if (!Number.isFinite(price) || price <= 0) {
      price = getRealisticFallbackPrice(symbol);
    }

    if (!Number.isFinite(price) || price <= 0) {
      price = 100;
    }

    safeStorePrice(symbol, price, null);

    return Number(price);
  } catch (err) {
    console.warn("resolveUniversalPrice error:", err?.message || err);
    return 100;
  }
}

async function getLatestPriceResponse(rawSymbol) {
  const symbol = normalizeUniversalSymbol(rawSymbol);
  if (!symbol) return null;

  const price = await resolveUniversalPrice(symbol);
  return {
    ok: true,
    symbol,
    price,
    currentPrice: price,
    last: price,
    close: price,
    updatedAt: new Date().toISOString(),
  };
}

async function resolvePriceWithFallback(symbol, body = {}) {
  const direct = normalizePrice(body);
  if (direct) return direct;
  return await resolveUniversalPrice(symbol);
}

function isClosedPosition(p = {}) {
  const status = String(p.status || p.state || p.positionStatus || "").toLowerCase().trim();
  return status.includes("close") || status === "closed" || !!p.closedAt || !!p.closed_at;
}

function computePositionPnl(position = {}, currentPrice = null) {
  const entry = Number(position.entryPrice ?? position.price ?? position.openPrice ?? 0) || 0;
  const qty = Number(position.qty ?? position.quantity ?? position.amount ?? position.positionSize ?? 0) || 0;
  const side = normalizeSide(position.side || position.direction || position.positionSide);
  const px = Number(currentPrice ?? position.currentPrice ?? entry) || entry;
  const sign = side === "SELL" ? -1 : 1;
  return (px - entry) * qty * sign;
}

function annotatePosition(position = {}) {
  const entryPrice = Number(position.entryPrice ?? position.price ?? position.openPrice ?? 0) || 0;
  let currentPrice = Number(position.currentPrice);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) currentPrice = getCurrentPriceForSymbol(position.symbol);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) currentPrice = entryPrice;
  const qty = Number(position.qty ?? position.quantity ?? position.amount ?? position.positionSize ?? 0) || 0;
  const side = normalizeSide(position.side || position.direction || position.positionSide);
  const sign = side === "SELL" ? -1 : 1;
  const pnl = isClosedPosition(position)
    ? Number(position.realizedPnl ?? position.pnl ?? 0) || 0
    : (currentPrice - entryPrice) * qty * sign;
  return { ...position, entryPrice, currentPrice, qty, pnl, unrealizedPnl: pnl, isOpen: !isClosedPosition(position) };
}

async function getUserDocFromBearer(req) {
  try {
    const auth = req.headers.authorization || req.headers.Authorization || null;
    if (!auth || !auth.toLowerCase().startsWith("bearer ")) return null;
    const token = String(auth).split(" ")[1];
    if (!token || !process.env.JWT_SECRET) return null;
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const userId = payload && (payload.id || payload.sub || payload.userId || payload._id);
    if (!userId) return null;
    return await User.findById(userId).catch(() => null);
  } catch {
    return null;
  }
}

async function getWalletDocForUser(userId) {
  let wallet = await Wallet.findOne({ user: userId }).catch(() => null);
  if (!wallet) {
    wallet = new Wallet({
      user: userId,
      balanceOwn: 0,
      balance: 0,
      credit: 0,
      marginUsed: 0,
      leverageFactor: 1,
      equity: 0,
      freeMargin: 0,
      marginLevel: 0,
      currency: "USD",
    });
  }
  return wallet;
}

function normalizeWalletSnapshot(wallet, openPnl = 0) {
  const balanceOwn = Number(wallet?.balanceOwn ?? wallet?.balance ?? 0) || 0;
  const credit = Number(wallet?.credit ?? 0) || 0;
  const marginUsed = Math.max(Number(wallet?.marginUsed ?? 0) || 0, 0);
  const pnl = Number(openPnl ?? 0) || 0;
  const equity = balanceOwn + pnl + credit;
  const freeMargin = Math.max(equity - marginUsed, 0);
  const marginLevel = marginUsed > 0 ? (equity / marginUsed) * 100 : 0;
  return {
    balance: balanceOwn,
    balanceOwn,
    credit,
    equity,
    marginUsed,
    freeMargin,
    availableBalance: freeMargin,
    marginLevel,
    leverageFactor: Number(wallet?.leverageFactor ?? 1) || 1,
    currency: "USD",
    openPnl: pnl,
  };
}

function getEffectiveBalance(userDoc, walletDoc) {
  const walletBalance = Number(walletDoc?.balanceOwn ?? walletDoc?.balance);
  const userBalance = Number(userDoc?.balanceOwn ?? userDoc?.balance);
  if (Number.isFinite(walletBalance)) return walletBalance;
  if (Number.isFinite(userBalance)) return userBalance;
  return 0;
}

const transactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    userId: { type: String, index: true },
    type: { type: String, index: true },
    amount: { type: Number, default: 0 },
    status: { type: String, default: "completed" },
    note: { type: String, default: "" },
    balanceBefore: { type: Number, default: 0 },
    balanceAfter: { type: Number, default: 0 },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    source: { type: String, default: "server.js" },
    createdAt: { type: Date, default: Date.now },
  },
  { minimize: false }
);

const Transaction = mongoose.models.Transaction || mongoose.model("Transaction", transactionSchema);

async function recordTransaction({ user, type, amount = 0, status = "completed", note = "", balanceBefore = 0, balanceAfter = 0, meta = {}, source = "server.js" }) {
  try {
    const tx = await Transaction.create({
      user: user?._id || null,
      userId: String(user?._id || ""),
      type,
      amount: Number(amount) || 0,
      status,
      note,
      balanceBefore: Number(balanceBefore) || 0,
      balanceAfter: Number(balanceAfter) || 0,
      meta,
      source,
      createdAt: new Date(),
    });
    return tx.toObject ? tx.toObject() : tx;
  } catch (err) {
    console.warn("recordTransaction fallback:", err?.message || err);
    return {
      userId: String(user?._id || ""),
      type,
      amount: Number(amount) || 0,
      status,
      note,
      balanceBefore: Number(balanceBefore) || 0,
      balanceAfter: Number(balanceAfter) || 0,
      meta,
      source,
      createdAt: new Date().toISOString(),
    };
  }
}

async function loadTransactionsForUser(userId, limit = 50) {
  return await Transaction.find({ user: userId }).sort({ createdAt: -1 }).limit(limit).lean().exec().catch(() => []);
}

async function loadOpenPositionsForUser(userId) {
  const rows = await Position.find({ user: userId, status: { $in: ["OPEN", "open", "Open"] } }).sort({ createdAt: -1 }).lean().exec().catch(() => []);
  return (rows || []).map((p) => { try { return annotatePosition(p); } catch { return p; } });
}

async function loadAllPositionsForUser(userId) {
  const rows = await Position.find({ user: userId }).sort({ createdAt: -1 }).lean().exec().catch(() => []);
  return (rows || []).map((p) => { try { return annotatePosition(p); } catch { return p; } });
}

async function buildAccountForUser(userDoc) {
  const wallet = await getWalletDocForUser(userDoc._id);
  const openPositions = await loadOpenPositionsForUser(userDoc._id);
  const allPositions = await loadAllPositionsForUser(userDoc._id);
  const recentTransactions = await loadTransactionsForUser(userDoc._id, 20);
  const walletSnapshot = wallet?.toObject ? wallet.toObject() : wallet;
  const balance = getEffectiveBalance(userDoc, walletSnapshot);
  const openPnl = (openPositions || []).reduce((sum, p) => sum + (Number(p.unrealizedPnl ?? p.pnl ?? 0) || 0), 0);
  const normalizedWallet = normalizeWalletSnapshot(
    walletSnapshot ? { ...walletSnapshot, balanceOwn: balance, balance } : { balanceOwn: balance, balance },
    openPnl
  );

  return {
    account: {
      ...normalizedWallet,
      balance,
      balanceOwn: balance,
      availableBalance: normalizedWallet.availableBalance,
      equity: normalizedWallet.equity,
      leverage: Number(userDoc.leverage ?? walletSnapshot?.leverageFactor ?? 100) || 100,
      currency: "USD",
      positions: openPositions,
      openPositions,
      allPositions,
      recentTransactions,
      transactions: recentTransactions,
      openPnl,
    },
    user: userDoc.toObject ? userDoc.toObject() : userDoc,
    wallet: walletSnapshot,
    positions: openPositions,
    transactions: recentTransactions,
  };
}

function emitStateUpdates(userId, accountPayload = null, positions = null, transaction = null) {
  try {
    const account = accountPayload?.account || accountPayload || null;
    const payload = { userId, account };
    io.emit("wallet_update", payload);
    io.emit("account_update", payload);
    if (Array.isArray(positions)) io.emit("positions_update", { userId, positions });
    if (transaction) io.emit("transactions_update", { userId, transaction });
    if (userId) {
      const room = `user:${String(userId)}`;
      io.to(room).emit("wallet_update", payload);
      io.to(room).emit("account_update", payload);
      if (Array.isArray(positions)) io.to(room).emit("positions_update", { userId, positions });
      if (transaction) io.to(room).emit("transactions_update", { userId, transaction });
    }
  } catch (e) {
    console.warn("emitStateUpdates error:", e?.message || e);
  }
}

async function requireAdmin(req, res, next) {
  try {
    const key = String(req.headers["x-admin-api-key"] || req.headers["x-admin-key"] || "");
    if (process.env.ADMIN_API_KEY && key && key === process.env.ADMIN_API_KEY) return next();
    const auth = req.headers.authorization || req.headers.Authorization || "";
    const token = String(auth).toLowerCase().startsWith("bearer ") ? String(auth).split(" ")[1] : "";
    if (!token || !process.env.JWT_SECRET) return res.status(401).json({ ok: false, error: "Admin unauthorized" });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const role = String(payload?.role || payload?.type || "").toLowerCase();
    if (role === "admin" || payload?.isAdmin === true || payload?.admin === true) {
      req.user = payload;
      return next();
    }
    return res.status(401).json({ ok: false, error: "Admin unauthorized" });
  } catch {
    return res.status(401).json({ ok: false, error: "Admin unauthorized" });
  }
}

function buildEmptyAccountPayload(userDoc) {
  const walletSnapshot = normalizeWalletSnapshot(
    {
      balanceOwn: 0,
      balance: 0,
      credit: 0,
      marginUsed: 0,
      leverageFactor: Number(userDoc?.leverage ?? 1) || 1,
      equity: 0,
      freeMargin: 0,
      marginLevel: 0,
      currency: "USD",
    },
    0
  );

  return {
    account: {
      ...walletSnapshot,
      balance: 0,
      balanceOwn: 0,
      availableBalance: 0,
      equity: 0,
      leverage: Number(userDoc?.leverage ?? 100) || 100,
      currency: "USD",
      positions: [],
      openPositions: [],
      allPositions: [],
      recentTransactions: [],
      transactions: [],
      openPnl: 0,
    },
    user: userDoc?.toObject ? userDoc.toObject() : userDoc || null,
    wallet: walletSnapshot,
    positions: [],
    transactions: [],
  };
}

async function safeBuildAccountForUser(userDoc) {
  try { return await buildAccountForUser(userDoc); } catch (err) { console.error("buildAccountForUser failed:", err); return buildEmptyAccountPayload(userDoc); }
}

async function safeLoadOpenPositionsForUser(userId) {
  try {
    const rows = await Position.find({ user: userId, status: { $in: ["OPEN", "open", "Open"] } }).sort({ createdAt: -1 }).lean().exec().catch(() => []);
    return (rows || []).map((p) => { try { return annotatePosition(p); } catch { return p; } });
  } catch (err) {
    console.error("safeLoadOpenPositionsForUser failed:", err);
    return [];
  }
}

async function safeLoadAllPositionsForUser(userId) {
  try {
    const rows = await Position.find({ user: userId }).sort({ createdAt: -1 }).lean().exec().catch(() => []);
    return (rows || []).map((p) => { try { return annotatePosition(p); } catch { return p; } });
  } catch (err) {
    console.error("safeLoadAllPositionsForUser failed:", err);
    return [];
  }
}

async function safeLoadTransactionsForUser(userId, limit = 50) {
  try { return await loadTransactionsForUser(userId, limit); } catch (err) { console.error("safeLoadTransactionsForUser failed:", err); return []; }
}

async function safeGetUserFromBearer(req) {
  try { return await getUserDocFromBearer(req); } catch (err) { console.error("getUserDocFromBearer failed:", err); return null; }
}

function scheduleLivePnLSync(symbol) {
  const key = compactSymbol(symbol);
  if (!key) return;
  const prev = liveSyncTimers.get(key);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(async () => {
    liveSyncTimers.delete(key);
    try { await syncLivePnLForSymbol(symbol); } catch (e) { console.warn("syncLivePnL error:", e?.message || e); }
  }, 120);
  if (timer?.unref) timer.unref();
  liveSyncTimers.set(key, timer);
}

async function syncLivePnLForSymbol(symbol) {
  try {
    const targetCompact = compactSymbol(symbol);
    if (!targetCompact) return;
    const currentPrice = getCurrentPriceForSymbol(symbol);
    if (!currentPrice || !Number.isFinite(currentPrice) || currentPrice <= 0) return;
    const openRows = await Position.find({ status: { $in: ["OPEN", "open"] } }).lean();
    if (!openRows.length) return;
    const matchedRows = openRows.filter((p) => {
      const candidates = [p.symbol, p.tvSymbol, p.selectedSymbol, p.chartSymbol, p.instrument, p.marketSymbol, p.market, p.ticker, p.asset].filter(Boolean);
      return candidates.some((candidate) => {
        const c = compactSymbol(candidate);
        return c === targetCompact || c.includes(targetCompact) || targetCompact.includes(c) || sameMarketSymbol(c, targetCompact);
      });
    });
    if (!matchedRows.length) return;
    const updateTime = new Date();
    for (const pos of matchedRows) {
      const livePnl = computePositionPnl(pos, currentPrice);
      await Position.updateOne(
        { _id: pos._id },
        { $set: { currentPrice, pnl: livePnl, unrealizedPnl: livePnl, updatedAt: updateTime } }
      ).catch(() => null);
    }
    const userIds = [...new Set(matchedRows.map((p) => String(p.user)))];
    for (const userId of userIds) {
      const user = await User.findById(userId);
      if (!user) continue;
      const account = await safeBuildAccountForUser(user);
      emitStateUpdates(user._id, account, account.positions || [], null);
    }
  } catch (e) {
    console.warn("syncLivePnL failed:", e?.message || e);
  }
}

async function applyCloseToPosition({ user, positionDoc, currentPrice, source = "api/trade/close" }) {
  const position = positionDoc?.toObject ? positionDoc.toObject() : positionDoc;
  const symbol = String(position.symbol || "").toUpperCase();
  const side = normalizeSide(position.side || position.direction);
  const entryPrice = Number(position.entryPrice ?? position.price ?? position.openPrice ?? 0) || 0;
  const qty = Number(position.qty ?? position.quantity ?? position.amount ?? 0) || 0;
  const sign = side === "SELL" ? -1 : 1;
  const closePx = Number(currentPrice) > 0 ? Number(currentPrice) : entryPrice;
  const realizedPnl = (closePx - entryPrice) * qty * sign;

  const wallet = await getWalletDocForUser(user._id);
  const balanceBefore = Number(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) || 0;
  const reservedMargin = Number(position.marginReserved ?? 0) || 0;
  const marginUsedBefore = Number(wallet.marginUsed ?? 0) || 0;
  const credit = Number(wallet.credit ?? 0) || 0;

  wallet.marginUsed = Math.max(marginUsedBefore - reservedMargin, 0);
  wallet.balanceOwn = Math.max(balanceBefore + reservedMargin + realizedPnl, 0);
  wallet.balance = wallet.balanceOwn;
  wallet.equity = wallet.balanceOwn + wallet.marginUsed + credit;
  wallet.freeMargin = Math.max(wallet.equity - wallet.marginUsed, 0);
  wallet.marginLevel = wallet.marginUsed > 0 ? (wallet.equity / wallet.marginUsed) * 100 : 0;
  wallet.updatedAt = new Date();
  await wallet.save();

  user.balance = wallet.balanceOwn;
  user.currency = "USD";
  await user.save();

  position.status = "CLOSED";
  position.currentPrice = closePx;
  position.closePrice = closePx;
  position.realizedPnl = realizedPnl;
  position.pnl = realizedPnl;
  position.closedAt = new Date();
  position.updatedAt = new Date();
  await positionDoc.save();

  const tx = await recordTransaction({
    user,
    type: "trade_close",
    amount: realizedPnl,
    status: "completed",
    note: `${side} ${symbol}`,
    balanceBefore,
    balanceAfter: wallet.balanceOwn,
    meta: { positionId: String(position._id), symbol, side, qty, entryPrice, closePrice: closePx, marginReleased: reservedMargin, realizedPnl },
    source,
  });

  const account = await safeBuildAccountForUser(user);
  const annotatedPosition = annotatePosition(position);
  emitStateUpdates(user._id, account, [annotatedPosition], tx);

  return {
    positionId: position._id,
    symbol,
    side,
    qty,
    entryPrice,
    currentPrice: closePx,
    realizedPnl,
    balance: wallet.balanceOwn,
    account: account.account,
    wallet: account.wallet,
    position: annotatedPosition,
    transaction: tx,
  };
}

async function buildQuotesArray() {
  const store = getPriceStore();
  const sampleQuotes = [];

  for (const sample of SAMPLE_SYMBOLS) {
    let found = findBestPriceMatch(sample.symbol, store);
    if (!found || !Number.isFinite(extractQuotePrice(found)) || extractQuotePrice(found) <= 0) {
      const latest = await getLatestPriceResponse(sample.symbol);
      found = latest || sample;
    }
    sampleQuotes.push(normalizeQuote(sample.symbol, found || sample));
  }

  const extraKeys = Object.keys(getPriceStore()).filter((key) => {
    return !SAMPLE_SYMBOLS.some((sample) => buildSymbolAliases(sample.symbol).some((alias) => buildSymbolAliases(key).includes(alias)));
  });

  const extraQuotes = extraKeys.map((key) => normalizeQuote(key, getPriceStore()[key] || {}));
  return [...sampleQuotes, ...extraQuotes];
}

async function buildMarketPayload() {
  const quotes = await buildQuotesArray();
  const latest = quotes.find((q) => Number.isFinite(q.price) && q.price > 0) || quotes[0] || null;
  return {
    ok: true,
    count: quotes.length,
    quotes,
    data: quotes,
    items: quotes,
    latest,
  };
}

/* ======================================================
   HEALTH / MAIL
   ====================================================== */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    env: process.env.NODE_ENV || "dev",
    emailProvider: process.env.RESEND_API_KEY ? "resend" : process.env.EMAIL_USER || process.env.SMTP_USER ? "smtp" : "none",
    db: mongoose.connection.name || null,
    adminApiKeyConfigured: !!process.env.ADMIN_API_KEY,
  });
});

app.locals.sendVerificationEmail = async ({ user, verificationLink }) => {
  try {
    const to = user?.email || user?.address || user;
    if (!to) return { ok: false, error: "missing_recipient" };
    if (!verificationLink) return { ok: false, error: "missing_verification_link" };
    const name = user?.name || "usuario";
    return await sendEmail({
      to,
      subject: "Verifica tu cuenta - Leones Broker",
      html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#111"><h2>Hola ${name}, verifica tu cuenta</h2><p>Haz clic en el botón de abajo para activar tu cuenta:</p><p><a href="${verificationLink}" style="display:inline-block;background:#d4af37;color:#000;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold">Verificar cuenta</a></p><p>Si el botón no funciona, copia y pega este enlace en tu navegador:</p><p>${verificationLink}</p></div>`,
    });
  } catch (err) {
    console.error("[MAIL] sendVerificationEmail error:", err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
};

app.post("/api/_send_test_email", async (req, res) => {
  const to = (req.body && req.body.to) || process.env.SENDER_EMAIL;
  if (!to) return res.status(400).json({ ok: false, message: "Necesitas enviar 'to' en el body o configurar SENDER_EMAIL" });
  const subject = req.body.subject || "Prueba de correo - Leones Broker";
  const html = req.body.html || `<p>Esto es una prueba desde el servidor de Leones Broker. Si recibes este correo, Resend/SMTP está funcionando.</p>`;
  try {
    const r = await sendEmail({ to, subject, html });
    if (r.ok) return res.json({ ok: true, message: "Correo enviado", provider: r.provider, result: r.result || r.info || r.resp });
    return res.status(500).json({ ok: false, message: "No se pudo enviar correo", error: r.error });
  } catch (err) {
    console.error("test email error:", err);
    return res.status(500).json({ ok: false, message: "Error interno enviando correo", error: err && err.message ? err.message : String(err) });
  }
});

/* ======================================================
   MARKET ROUTES
   ====================================================== */

app.get("/api/markets", (req, res) => res.json({ markets: ["Crypto", "Stocks", "Forex", "Indices", "Commodities"] }));
app.get("/api/market/list", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/market/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/markets/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/api/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/api/markets", (req, res) => res.json({ markets: ["Crypto", "Stocks", "Forex", "Indices", "Commodities"] }));

try {
  if (typeof marketRoutesFactory === "function") {
    app.use("/api/market", marketRoutesFactory({ polygonSocket: null, priceHandler }));
  } else {
    app.use("/api/market", marketRoutesFactory);
  }
} catch (e) {
  console.warn("No se pudo montar /api/market:", e && e.message ? e.message : e);
}

/* ======================================================
   PRICE API
   ====================================================== */

app.get("/api/price", async (req, res) => {
  try {
    const rawSymbol = String(req.query.symbol || req.query.tvSymbol || req.query.selectedSymbol || "");
    const symbol = normalizeUniversalSymbol(rawSymbol);

    if (!symbol) {
      return res.status(400).json({ ok: false, error: "Símbolo requerido" });
    }

    forcePriceExists(symbol);

    const latest = await getLatestPriceResponse(symbol);

    if (!latest || !Number.isFinite(latest.price) || latest.price <= 0) {
      const fallbackPrice = forcePriceExists(symbol) || global.getFakePrice(symbol) || getRealisticFallbackPrice(symbol) || 100;
      safeStorePrice(symbol, fallbackPrice, null);
      return res.json({
        ok: true,
        symbol,
        price: fallbackPrice,
        currentPrice: fallbackPrice,
        last: fallbackPrice,
        close: fallbackPrice,
        updatedAt: new Date().toISOString(),
      });
    }

    return res.json({
      ok: true,
      symbol: latest.symbol,
      price: Number(latest.price),
      currentPrice: Number(latest.price),
      last: Number(latest.price),
      close: Number(latest.price),
      updatedAt: latest.updatedAt || new Date().toISOString(),
    });
  } catch (err) {
    try {
      const fallbackSymbol = normalizeUniversalSymbol(req.query.symbol || req.query.tvSymbol || req.query.selectedSymbol || "");
      if (fallbackSymbol) {
        const fallbackPrice = forcePriceExists(fallbackSymbol) || global.getFakePrice(fallbackSymbol) || getRealisticFallbackPrice(fallbackSymbol) || 100;
        safeStorePrice(fallbackSymbol, fallbackPrice, null);
        return res.json({
          ok: true,
          symbol: fallbackSymbol,
          price: fallbackPrice,
          currentPrice: fallbackPrice,
          last: fallbackPrice,
          close: fallbackPrice,
          updatedAt: new Date().toISOString(),
        });
      }
    } catch {}

    console.error("Error /api/price:", err);
    return res.status(500).json({ ok: false, error: "Error interno" });
  }
});

app.get("/api/latest", async (req, res) => {
  try {
    const rawSymbol = req.query.symbol || req.query.tvSymbol || req.query.selectedSymbol || "";
    const symbol = normalizeUniversalSymbol(rawSymbol);

    if (!symbol) {
      return res.json({ ok: true, symbol: null, price: null, currentPrice: null, close: null, last: null, updatedAt: new Date().toISOString(), message: "symbol_missing" });
    }

    const latest = await getLatestPriceResponse(symbol);
    return res.json(latest || { ok: false, error: "price_not_found", symbol });
  } catch {
    const symbol = normalizeUniversalSymbol(req.query.symbol || req.query.tvSymbol || req.query.selectedSymbol || "");
    const price = forcePriceExists(symbol) || global.getFakePrice(symbol) || getRealisticFallbackPrice(symbol) || 100;
    safeStorePrice(symbol, price, null);
    return res.json({ ok: true, symbol, price, currentPrice: price, close: price, last: price, updatedAt: new Date().toISOString() });
  }
});

app.get("/api/market/latest", async (req, res) => {
  try {
    const rawSymbol = req.query.symbol || req.query.tvSymbol || req.query.selectedSymbol || "";
    const symbol = normalizeUniversalSymbol(rawSymbol);

    if (!symbol) {
      return res.json({ ok: true, symbol: null, price: null, currentPrice: null, close: null, last: null, updatedAt: new Date().toISOString(), message: "symbol_missing" });
    }

    const latest = await getLatestPriceResponse(symbol);
    return res.json(latest || { ok: false, error: "price_not_found", symbol });
  } catch {
    const symbol = normalizeUniversalSymbol(req.query.symbol || req.query.tvSymbol || req.query.selectedSymbol || "");
    const price = forcePriceExists(symbol) || global.getFakePrice(symbol) || getRealisticFallbackPrice(symbol) || 100;
    safeStorePrice(symbol, price, null);
    return res.json({ ok: true, symbol, price, currentPrice: price, close: price, last: price, updatedAt: new Date().toISOString() });
  }
});

app.get("/api/quotes", async (req, res) => {
  try {
    const payload = await buildMarketPayload();
    return res.json(payload);
  } catch {
    return res.json({ ok: true, count: 0, quotes: [], data: [], items: [], latest: null });
  }
});

app.get("/api/market/quotes", async (req, res) => {
  try {
    const payload = await buildMarketPayload();
    return res.json(payload);
  } catch {
    return res.json({ ok: true, count: 0, quotes: [], data: [], items: [], latest: null });
  }
});

app.get("/api/market/polygon/quotes", async (req, res) => {
  try {
    const payload = await buildMarketPayload();
    return res.json(payload);
  } catch {
    return res.json({ ok: true, count: 0, quotes: [], data: [], items: [], latest: null });
  }
});

/* ======================================================
   DEBUG / SYMBOL LISTS
   ====================================================== */

app.get("/api/market/polygon/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/symbols", (req, res) => {
  try {
    const prices = getPriceStore();
    if (prices && Object.keys(prices).length) {
      return res.json(Object.keys(prices).map((k) => ({ symbol: k, label: formatSymbolLabel(k), market: prices[k]?.market || "Unknown" })));
    }
    return res.json(SAMPLE_SYMBOLS);
  } catch (err) {
    console.error("api/symbols error:", err);
    return res.json(SAMPLE_SYMBOLS);
  }
});

/* ======================================================
   ACCOUNT / WALLET / POSITIONS
   ====================================================== */

app.get("/api/account", async (req, res) => {
  try {
    const user = await safeGetUserFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    return res.json(await safeBuildAccountForUser(user));
  } catch (e) {
    console.error("account error", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.get("/api/me", async (req, res) => {
  try {
    const user = await safeGetUserFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    return res.status(200).json(await safeBuildAccountForUser(user));
  } catch (e) {
    console.error("/api/me error", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.get("/api/profile", async (req, res) => {
  try {
    const user = await safeGetUserFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    return res.json(await safeBuildAccountForUser(user));
  } catch (e) {
    console.error("profile error", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.get("/api/cuenta", (req, res) => res.redirect(307, "/api/account"));

app.get("/api/transactions", async (req, res) => {
  try {
    const user = await safeGetUserFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    const limit = Math.min(Number(req.query.limit || 50) || 50, 200);
    const transactions = await safeLoadTransactionsForUser(user._id, limit);
    return res.json({ ok: true, count: transactions.length, transactions, data: transactions, items: transactions });
  } catch (e) {
    console.error("/api/transactions error", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.get("/api/wallet", async (req, res) => {
  try {
    const user = await safeGetUserFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    const payload = await safeBuildAccountForUser(user);
    return res.json({
      ok: true,
      wallet: payload.wallet,
      account: payload.account,
      balance: payload.account.balance,
      balanceOwn: payload.account.balanceOwn,
      availableBalance: payload.account.availableBalance,
      equity: payload.account.equity,
      marginUsed: payload.account.marginUsed,
      freeMargin: payload.account.freeMargin,
      marginLevel: payload.account.marginLevel,
      leverageFactor: payload.account.leverageFactor,
      currency: payload.account.currency,
      transactions: payload.transactions,
    });
  } catch (e) {
    console.error("/api/wallet error", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.get("/api/billetera", (req, res) => res.redirect(307, "/api/wallet"));

app.get("/api/positions", async (req, res) => {
  try {
    const user = await safeGetUserFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    const positions = await safeLoadOpenPositionsForUser(user._id);
    return res.json({ ok: true, positions, data: positions, items: positions, count: positions.length });
  } catch (e) {
    console.error("/api/positions error", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.get("/api/posiciones", async (req, res) => {
  try {
    const user = await safeGetUserFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    const positions = await safeLoadOpenPositionsForUser(user._id);
    return res.json({ ok: true, positions, data: positions, items: positions, count: positions.length });
  } catch (e) {
    console.error("/api/posiciones error", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.get("/api/positions/all", async (req, res) => {
  try {
    const user = await safeGetUserFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    const positions = await safeLoadAllPositionsForUser(user._id);
    return res.json({ ok: true, positions, data: positions, items: positions, count: positions.length });
  } catch (e) {
    console.error("/api/positions/all error", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.get("/api/posiciones/all", async (req, res) => {
  try {
    const user = await safeGetUserFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    const positions = await safeLoadAllPositionsForUser(user._id);
    return res.json({ ok: true, positions, data: positions, items: positions, count: positions.length });
  } catch (e) {
    console.error("/api/posiciones/all error", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.get("/api/trade/positions", async (req, res) => {
  try {
    const user = await safeGetUserFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    const positions = await safeLoadOpenPositionsForUser(user._id);
    return res.json({ ok: true, positions, data: positions, items: positions, count: positions.length });
  } catch (e) {
    console.error("/api/trade/positions error", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/* ======================================================
   ADMIN
   ====================================================== */

app.post("/api/admin/deposit", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const userId = body.userId || body.user || body.clientId || null;
    const amount = Number(body.amount ?? body.depositAmount ?? body.balance ?? 0);
    const leverage = body.leverage !== undefined ? Number(body.leverage) : null;
    const note = String(body.note || body.description || "Admin deposit").trim();
    const currency = "USD";

    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: "amount_required" });

    const user = await User.findById(userId).catch(() => null);
    if (!user) return res.status(404).json({ ok: false, error: "user_not_found" });

    const wallet = await getWalletDocForUser(user._id);
    const balanceBefore = Number(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) || 0;

    wallet.balanceOwn = balanceBefore + amount;
    wallet.balance = wallet.balanceOwn;
    wallet.currency = currency;

    if (Number.isFinite(leverage) && leverage > 0) {
      wallet.leverageFactor = leverage;
      user.leverage = leverage;
    }

    wallet.equity = wallet.balanceOwn + Number(wallet.credit ?? 0);
    wallet.marginUsed = Number(wallet.marginUsed ?? 0) || 0;
    wallet.freeMargin = Math.max(wallet.equity - wallet.marginUsed, 0);
    wallet.updatedAt = new Date();
    await wallet.save();

    user.balance = wallet.balanceOwn;
    user.currency = currency;
    if (Number.isFinite(leverage) && leverage > 0) user.leverage = leverage;
    await user.save();

    const tx = await recordTransaction({
      user,
      type: "deposit",
      amount,
      status: "completed",
      note,
      balanceBefore,
      balanceAfter: wallet.balanceOwn,
      meta: { source: "admin-panel", method: body.method || "deposit", currency, leverage: wallet.leverageFactor },
      source: "api/admin/deposit",
    });

    const account = await safeBuildAccountForUser(user);
    emitStateUpdates(user._id, account, null, tx);

    return res.json({
      ok: true,
      msg: "Depósito aplicado",
      data: {
        balance: wallet.balanceOwn,
        leverage: wallet.leverageFactor,
        transaction: tx,
        account: account.account,
        wallet: account.wallet,
      },
    });
  } catch (err) {
    console.error("/api/admin/deposit error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  }
});

app.post("/api/admin/withdraw", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const userId = body.userId || body.user || body.clientId || null;
    const amount = Number(body.amount ?? body.withdrawAmount ?? 0);
    const note = String(body.note || body.description || "Admin withdrawal").trim();

    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: "amount_required" });

    const user = await User.findById(userId).catch(() => null);
    if (!user) return res.status(404).json({ ok: false, error: "user_not_found" });

    const wallet = await getWalletDocForUser(user._id);
    const balanceBefore = Number(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) || 0;

    if (balanceBefore < amount) {
      return res.status(400).json({ ok: false, error: "insufficient_balance", message: "Saldo insuficiente" });
    }

    wallet.balanceOwn = balanceBefore - amount;
    wallet.balance = wallet.balanceOwn;
    wallet.equity = wallet.balanceOwn + Number(wallet.credit ?? 0);
    wallet.freeMargin = Math.max(wallet.equity - Number(wallet.marginUsed ?? 0), 0);
    wallet.updatedAt = new Date();
    await wallet.save();

    user.balance = wallet.balanceOwn;
    user.currency = "USD";
    await user.save();

    const tx = await recordTransaction({
      user,
      type: "withdrawal",
      amount: -Math.abs(amount),
      status: "completed",
      note,
      balanceBefore,
      balanceAfter: wallet.balanceOwn,
      meta: { source: "admin-panel" },
      source: "api/admin/withdraw",
    });

    const account = await safeBuildAccountForUser(user);
    emitStateUpdates(user._id, account, null, tx);

    return res.json({
      ok: true,
      msg: "Retiro aplicado",
      data: {
        balance: wallet.balanceOwn,
        transaction: tx,
        account: account.account,
        wallet: account.wallet,
      },
    });
  } catch (err) {
    console.error("/api/admin/withdraw error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  }
});

app.get("/api/admin/transactions", requireAdmin, async (req, res) => {
  try {
    const userId = req.query.userId || null;
    const limit = Math.min(Number(req.query.limit || 100) || 100, 500);
    const txs = userId
      ? await safeLoadTransactionsForUser(userId, limit)
      : await Transaction.find({}).sort({ createdAt: -1 }).limit(limit).lean().exec().catch(() => []);
    return res.json({ ok: true, count: txs.length, transactions: txs, data: txs, items: txs });
  } catch (err) {
    console.error("/api/admin/transactions error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  }
});

/* ======================================================
   TRADING CORE
   ====================================================== */

app.post("/api/trade/open", async (req, res) => {
  let lockKey = null;

  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const body = req.body || {};
    let symbol = normalizePositionSymbol(body);
    if (!symbol) symbol = normalizeUniversalSymbol(body.symbol || body.ticker || body.tvSymbol || body.selectedSymbol || body.chartSymbol || body.instrument || body.marketSymbol || body.asset || "");
    if (!symbol) return res.status(400).json({ ok: false, error: "invalid_symbol" });

    const side = normalizeSide(body.side || body.direction);
    const qty = normalizeQty(body);
    if (!side || !qty) return res.status(400).json({ ok: false, error: "invalid_params" });

    lockKey = makeOpenLockKey(user._id, symbol, side, qty);
    if (!withOpenLock(lockKey, 2500) || !withActiveOrder(lockKey, 2500)) {
      return res.status(429).json({ ok: false, error: "duplicate_order_blocked" });
    }

    const wallet = await getWalletDocForUser(user._id);
    const balanceOwn = Number(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) || 0;
    const credit = Number(wallet.credit ?? 0) || 0;
    const marginUsed = Number(wallet.marginUsed ?? 0) || 0;
    const leverage = Math.max(Number(wallet.leverageFactor ?? user.leverage ?? 1) || 1, 1);

    let price = await resolvePriceWithFallback(symbol, body);
    if (!Number.isFinite(price) || price <= 0) {
      price = global.getFakePrice?.(symbol) || forcePriceExists?.(symbol) || getRealisticFallbackPrice(symbol) || 100;
    }
    price = Number(price);
    if (!Number.isFinite(price) || price <= 0) price = 100;

    const notional = qty * price;
    let requiredMargin = notional / leverage;
    if (!Number.isFinite(requiredMargin) || requiredMargin <= 0) requiredMargin = 1;

    // no bloquea la apertura: usa el margen que exista y nunca rompe la orden
    const availableMargin = Math.max(balanceOwn + credit - marginUsed, 0);
    if (requiredMargin > availableMargin) {
      requiredMargin = Math.max(1, availableMargin > 0 ? availableMargin : 1);
    }

    wallet.balanceOwn = Math.max(balanceOwn - requiredMargin, 0);
    wallet.balance = wallet.balanceOwn;
    wallet.marginUsed = marginUsed + requiredMargin;
    wallet.equity = wallet.balanceOwn + credit;
    wallet.freeMargin = Math.max(wallet.equity - wallet.marginUsed, 0);
    wallet.marginLevel = wallet.marginUsed > 0 ? (wallet.equity / wallet.marginUsed) * 100 : 0;
    wallet.updatedAt = new Date();
    await wallet.save();

    const position = await Position.create({
      user: user._id,
      symbol,
      side,
      qty,
      entryPrice: price,
      currentPrice: price,
      marginReserved: requiredMargin,
      leverage,
      status: "OPEN",
      createdAt: new Date(),
      updatedAt: new Date(),
      currency: "USD",
    });

    const account = await safeBuildAccountForUser(user);
    const annotatedPosition = annotatePosition(position.toObject ? position.toObject() : position);

    emitStateUpdates(user._id, account, [annotatedPosition], null);
    scheduleLivePnLSync(symbol);

    return res.json({
      ok: true,
      msg: "OPENED",
      position,
      wallet: account.wallet,
      account: account.account,
      symbol,
      entryPrice: price,
    });
  } catch (err) {
    console.error("/api/trade/open error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  } finally {
    if (lockKey) {
      releaseOpenLock(lockKey);
      releaseActiveOrder(lockKey);
    }
  }
});

app.post("/api/trade/close", async (req, res) => {
  let lockKey = null;

  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const { positionId } = req.body || {};
    if (!positionId) return res.status(400).json({ ok: false, error: "positionId_required" });

    lockKey = makeCloseLockKey(user._id, positionId);
    if (!withOpenLock(lockKey, 2500)) return res.status(429).json({ ok: false, error: "duplicate_close_blocked" });

    const position = await Position.findOne({ _id: positionId, user: user._id, status: { $in: ["OPEN", "open", "Open"] } });
    if (!position) return res.status(404).json({ ok: false, error: "not_found" });

    const body = req.body || {};
    let price = await resolvePriceWithFallback(position.symbol, body);
    if (!Number.isFinite(price) || price <= 0) {
      price = global.getFakePrice?.(position.symbol) || forcePriceExists?.(position.symbol) || getRealisticFallbackPrice(position.symbol) || position.entryPrice;
    }
    price = Number(price);
    if (!Number.isFinite(price) || price <= 0) price = position.entryPrice || 100;

    const result = await applyCloseToPosition({ user, positionDoc: position, currentPrice: price, source: "api/trade/close" });
    scheduleLivePnLSync(position.symbol);

    return res.json({ ok: true, msg: "CLOSED", ...result });
  } catch (err) {
    console.error("/api/trade/close error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  } finally {
    if (lockKey) releaseOpenLock(lockKey);
  }
});

app.get("/api/trade/positions", async (req, res) => {
  try {
    const user = await safeGetUserFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    const positions = await safeLoadOpenPositionsForUser(user._id);
    return res.json({ ok: true, positions, data: positions, items: positions, count: positions.length });
  } catch (err) {
    console.error("/api/trade/positions error", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  }
});

/* ======================================================
   ROUTES MODULARES
   ====================================================== */

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/verification", verificationRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/positions", positionsRoutes);
app.use("/api/trade", tradeRoutes);
app.use("/api/account", accountRoutes);

app.use("/api/api", (req, res) => {
  const newUrl = req.originalUrl.replace(/^\/api\/api/, "/api");
  return res.redirect(307, newUrl);
});

/* ======================================================
   SOCKET.IO
   ====================================================== */

let polygonSocket = null;

function extractSymbol(data) {
  return normalizeUniversalSymbol(
    data?.symbol ||
    data?.ticker ||
    data?.sym ||
    data?.T ||
    data?.s ||
    data?.instrument ||
    data?.marketSymbol ||
    data?.asset ||
    data?.name ||
    data?.label ||
    ""
  );
}

function extractPrice(data = {}) {
  return extractQuotePrice(data);
}

function safeAutoSubscribeDefaults() {
  if (!polygonSocket?.subscribe) return;
  const symbols = ["X:BTCUSD", "X:ETHUSD", "C:EURUSD", "AAPL", "I:SPX"];
  for (const sym of symbols) {
    try {
      polygonSocket.subscribe(sym, "trades");
    } catch {}
  }
}

io.on("connection", (socket) => {
  console.log("📡 Cliente conectado:", socket.id);

  try {
    socket.emit("prices_snapshot", getPriceStore() || {});
  } catch {
    socket.emit("prices_snapshot", {});
  }

  socket.on("join_user_room", async ({ token, userId } = {}) => {
    try {
      let uid = String(userId || "").trim();
      if (!uid && token && process.env.JWT_SECRET) {
        const payload = jwt.verify(String(token), process.env.JWT_SECRET);
        uid = String(payload?.id || payload?.sub || payload?.userId || payload?._id || "").trim();
      }
      if (!uid) return;
      socket.join(`user:${uid}`);
      socket.data.userId = uid;
      socket.emit("room_joined", { ok: true, userId: uid });
    } catch {
      socket.emit("room_joined", { ok: false, error: "invalid_token" });
    }
  });

  socket.on("request_prices_snapshot", () => {
    try {
      socket.emit("prices_snapshot", getPriceStore() || {});
    } catch {
      socket.emit("prices_snapshot", {});
    }
  });

  socket.on("request_symbols", () => {
    try {
      const prices = getPriceStore();
      if (priceHandler && typeof priceHandler.getSymbols === "function") {
        socket.emit("symbols_update", priceHandler.getSymbols() || []);
      } else if (prices && Object.keys(prices).length) {
        socket.emit(
          "symbols_update",
          Object.keys(prices).map((k) => ({
            symbol: k,
            label: formatSymbolLabel(k),
            market: prices[k]?.market || "Unknown",
          }))
        );
      } else {
        socket.emit("symbols_update", SAMPLE_SYMBOLS);
      }
    } catch {
      socket.emit("symbols_update", SAMPLE_SYMBOLS);
    }
  });

  socket.on("subscribe", ({ symbol, kind } = {}) => {
    if (!symbol) return;
    try {
      const cleanSymbol = normalizeUniversalSymbol(symbol);
      const polygonSymbol = toPolygonSymbol(cleanSymbol);
      if (polygonSocket?.subscribe && polygonSymbol) {
        polygonSocket.subscribe(polygonSymbol, kind || "trades");
      }
      socket.join(cleanSymbol);
    } catch {}
  });

  socket.on("unsubscribe", ({ symbol, kind } = {}) => {
    if (!symbol) return;
    try {
      const cleanSymbol = normalizeUniversalSymbol(symbol);
      const polygonSymbol = toPolygonSymbol(cleanSymbol);
      if (polygonSocket?.unsubscribe && polygonSymbol) {
        polygonSocket.unsubscribe(polygonSymbol, kind || "trades");
      }
      socket.leave(cleanSymbol);
    } catch {}
  });

  socket.on("disconnect", (reason) => {
    console.log("❌ Cliente desconectado:", socket.id, "reason:", reason);
  });
});

/* ======================================================
   POLYGON SOCKET
   ====================================================== */

try {
  if (!process.env.POLYGON_API_KEY) {
    console.warn("⚠️ POLYGON_API_KEY no definido — realtime limitado");
  } else {
    polygonSocket = new PolygonSocket({
      apiKey: process.env.POLYGON_API_KEY,
      onPrice: async (data) => {
        try {
          const symbol = extractSymbol(data);
          let finalPrice = extractPrice(data);

          if (!symbol) return;

          if (!finalPrice || !Number.isFinite(finalPrice) || finalPrice <= 0) {
            const fallback = await fetchPolygonLastPrice(symbol);
            finalPrice = fallback?.price || null;
            if (finalPrice && Number.isFinite(finalPrice) && finalPrice > 0) {
              safeStorePrice(symbol, finalPrice, fallback.raw);
            }
          }

          if (!finalPrice || !Number.isFinite(finalPrice) || finalPrice <= 0) return;

          safeStorePrice(symbol, Number(finalPrice), data);

          if (priceHandler?.handle) {
            try { priceHandler.handle({ ...data, symbol, price: Number(finalPrice) }); } catch {}
          }
          if (typeof updatePriceStore === "function") {
            try { updatePriceStore(symbol, Number(finalPrice)); } catch {}
          }
          scheduleLivePnLSync(symbol);
        } catch {}
      },
      onOpen: async () => {
        try { safeAutoSubscribeDefaults(); } catch {}
      },
      onClose: () => {},
      onError: () => {},
    });

    const maybe = polygonSocket.connect();
    if (maybe && typeof maybe.then === "function") {
      maybe.catch((err) => {
        console.warn("❌ PolygonSocket.connect() rejected:", err?.message || err);
        polygonSocket = null;
      });
    }
  }
} catch (err) {
  console.error("❌ Error inicializando PolygonSocket:", err?.message || err);
  polygonSocket = null;
}

/* ======================================================
   STATIC
   ====================================================== */

const staticCandidates = ["public", "publico", "público", "Public", "Publico"];
let staticDirName = null;
for (const cand of staticCandidates) {
  const p = path.join(__dirname, cand);
  try {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      staticDirName = cand;
      break;
    }
  } catch {}
}
if (!staticDirName) {
  staticDirName = "public";
  console.warn(`WARN: No se encontró carpeta estática entre ${staticCandidates.join(", ")}. Usando fallback '${staticDirName}'.`);
} else {
  console.log(`Static folder detected: '${staticDirName}'`);
}

const staticPath = path.join(__dirname, staticDirName);
const jsDirPath = path.join(staticPath, "js");

function stripScriptWrappers(source) {
  let text = String(source ?? "");
  text = text.replace(/^\uFEFF/, "");
  const trimmed = text.trim();
  const startsWithScript = /^<script\b[^>]*>/i.test(trimmed);
  const endsWithScript = /<\/script>\s*$/.test(trimmed);
  if (startsWithScript && endsWithScript) {
    text = trimmed.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>\s*$/, "");
  }
  return text;
}

function resolveJsCandidate(requestPath) {
  const clean = String(requestPath || "").split("?")[0];
  const normalized = clean.replace(/\\/g, "/");
  const base = path.basename(normalized);
  const candidates = [];
  if (normalized.startsWith("/public/js/")) candidates.push(path.join(staticPath, normalized.replace(/^\/public\//, "")));
  if (normalized.startsWith("/js/")) {
    candidates.push(path.join(jsDirPath, normalized.slice("/js/".length)));
    candidates.push(path.join(staticPath, normalized.replace(/^\/+/, "")));
  }
  if (normalized.startsWith("/public/")) candidates.push(path.join(staticPath, normalized.replace(/^\/public\//, "")));
  if (base) {
    candidates.push(path.join(staticPath, base));
    candidates.push(path.join(jsDirPath, base));
  }
  const uniqueCandidates = [...new Set(candidates)];
  return uniqueCandidates.find((p) => {
    try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
  });
}

app.use(async (req, res, next) => {
  const pathname = req.path || "";
  if (!pathname.endsWith(".js")) return next();
  try {
    const candidate = resolveJsCandidate(pathname);
    if (candidate) {
      const raw = await fs.promises.readFile(candidate, "utf8");
      const cleaned = stripScriptWrappers(raw);
      res.status(200).type("application/javascript; charset=utf-8").send(cleaned);
      return;
    }
    res.status(404).type("application/javascript; charset=utf-8").send(`console.error("JS missing: ${pathname}");`);
  } catch (err) {
    console.error("Error sirviendo JS:", err);
    res.status(500).type("application/javascript; charset=utf-8").send(`console.error("JS server error");`);
  }
});

app.use("/public", express.static(staticPath));
app.use("/js", express.static(jsDirPath));
app.use(express.static(staticPath));

app.get("/dashboard.html", (req, res) => {
  res.sendFile(path.join(staticPath, "dashboard.html"));
});
app.get("/", (req, res) => {
  res.sendFile(path.join(staticPath, "index.html"));
});

/* ======================================================
   MORE MARKET ENDPOINTS
   ====================================================== */

app.get("/api/market/polygon/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));

/* ======================================================
   START / SHUTDOWN
   ====================================================== */

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/") || req.path === "/api") {
    return res.status(404).json({ error: "API endpoint not found" });
  }
  const indexPath = path.join(staticPath, "index.html");
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error("Error sirviendo index.html:", err);
      res.status(err.status || 500).send("Error loading app");
    }
  });
});

const PORT = Number(process.env.PORT) || 3000;

const server = httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on ${PORT}`);
  console.log("ENV STATUS:");
  console.log("RESEND:", !!process.env.RESEND_API_KEY);
  console.log("SENDER:", !!process.env.SENDER_EMAIL);
  console.log("MONGO:", !!process.env.MONGO_URI);
  console.log("ADMIN_API_KEY:", !!process.env.ADMIN_API_KEY);
  console.log("POLYGON:", !!process.env.POLYGON_API_KEY);
  if (!process.env.POLYGON_API_KEY) console.warn("⚠️ POLYGON_API_KEY no configurado — realtime limitado");
  if (!process.env.RESEND_API_KEY) console.warn("⚠️ Resend no configurado — emails pueden usar SMTP o simulación");
});

let shuttingDown = false;

const safeClosePolygonSocket = async () => {
  if (!polygonSocket) return;
  try {
    const maybe = polygonSocket.close();
    if (maybe && typeof maybe.then === "function") {
      await maybe.catch((err) => {
        console.warn("polygonSocket.close() rejected:", err);
      });
    }
  } catch (e) {
    console.warn("polygonSocket.close() threw:", e);
  }
};

const gracefulShutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`📴 ${signal} recibido. Cerrando...`);

  const timeout = setTimeout(() => {
    console.warn("Forzando cierre...");
    process.exit(1);
  }, 30000);
  timeout.unref();

  try {
    for (const t of liveSyncTimers.values()) clearTimeout(t);
    liveSyncTimers.clear();
    openTradeLocks.clear();
    activeOrders.clear();

    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    await safeClosePolygonSocket();

    if (typeof global?.stopRiskWatcher === "function") {
      try { global.stopRiskWatcher(); } catch (e) { console.warn("stopRiskWatcher threw:", e); }
    }

    await mongoose.disconnect();
    clearTimeout(timeout);
    process.exit(0);
  } catch (err) {
    console.error("Shutdown error:", err);
    clearTimeout(timeout);
    process.exit(1);
  }
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("unhandledRejection", (r) => {
  console.error("UnhandledRejection:", r);
  gracefulShutdown("unhandledRejection").catch(() => {});
});
process.on("uncaughtException", (e) => {
  console.error("UncaughtException:", e);
  gracefulShutdown("uncaughtException").catch(() => {});
});

export default app;
