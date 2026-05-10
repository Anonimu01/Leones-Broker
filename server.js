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
import sendEmail from "./utils/sendEmail.js";

import User from "./models/user.model.js";
import Wallet from "./models/wallet.model.js";
import Position from "./models/position.model.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path:
    process.env.NODE_ENV === "production"
      ? undefined
      : path.resolve(__dirname, ".env"),
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
    const stopFn = startRiskWatcher({
      intervalMs,
      alertThreshold,
      closeThreshold,
    });
    if (typeof stopFn === "function") global.stopRiskWatcher = stopFn;
    console.log(
      `🛡️ Risk watcher iniciado (interval=${intervalMs}ms alert=${alertThreshold}% close=${closeThreshold}%)`
    );
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
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
        return callback(null, true);
      }
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
  skip: (req) =>
    req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS",
});
app.use("/api", limiter);

const httpServer = createServer(app);
const io = new IOServer(httpServer, {
  cors: {
    origin: Array.from(allowedOrigins).length
      ? Array.from(allowedOrigins)
      : process.env.CLIENT_URL || "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const priceHandler = new PriceHandler(io);
app.locals.sendEmail = sendEmail;
app.locals.priceHandler = priceHandler;

/* ======================================================
   SINGLE SOURCE OF TRUTH: PRICE STORE
====================================================== */

global.priceCache = global.priceCache || {};
global.priceMeta = global.priceMeta || {};
global.marketQuotes = global.marketQuotes || {};

function normalizeSymbol(value = "") {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function compactSymbol(value = "") {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function sameMarketSymbol(a = "", b = "") {
  const x = compactSymbol(a);
  const y = compactSymbol(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function toPolygonSymbol(value = "") {
  const clean = normalizeSymbol(value);
  if (!clean) return "";
  if (/^[A-Z]{6}$/.test(clean) && !/\d/.test(clean)) return `C:${clean}`;
  return clean;
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
  )
    .trim()
    .toUpperCase();

  return normalizeSymbol(raw);
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

function safeExtractPrice(value = {}) {
  try {
    const price = Number(
      value?.price ??
        value?.lastPrice ??
        value?.last ??
        value?.close ??
        value?.c ??
        value
    );
    if (!Number.isFinite(price) || price <= 0) return null;
    return price;
  } catch {
    return null;
  }
}

function safeNormalizeQuote(symbol, value = {}) {
  const price = safeExtractPrice(value);
  if (!price) return null;
  return {
    symbol: normalizeSymbol(symbol),
    label:
      value.label ||
      value.name ||
      (normalizeSymbol(symbol).split(":").pop() || normalizeSymbol(symbol)).replace("_", "/"),
    market: value.market || "Unknown",
    price,
    bid: Number(value?.bid ?? price),
    ask: Number(value?.ask ?? price),
    open: toNumber(value?.open),
    high: toNumber(value?.high),
    low: toNumber(value?.low),
    volume: toNumber(value?.volume),
    change: toNumber(value?.change),
    changePercent: toNumber(value?.changePercent),
    updatedAt: value?.updatedAt || value?.timestamp || Date.now(),
    raw: value,
  };
}

function detectMarket(symbol = "") {
  const s = String(symbol || "")
    .toUpperCase()
    .replace("/", "")
    .replace("-", "")
    .trim();

  if (!s) return "stocks";

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
  ) {
    return "crypto";
  }

  if (/^[A-Z]{6}$/.test(s)) return "forex";

  if (
    s.includes("SPX") ||
    s.includes("NAS100") ||
    s.includes("DJ30") ||
    s.includes("DAX40") ||
    s.includes("FTSE100") ||
    s.includes("NIKKEI") ||
    s.includes("RUSSELL") ||
    s.includes("VIX")
  ) {
    return "indices";
  }

  if (
    s.includes("GOLD") ||
    s.includes("SILVER") ||
    s.includes("OIL") ||
    s.includes("WTI") ||
    s.includes("BRENT") ||
    s.includes("NATGAS") ||
    s.includes("COPPER") ||
    s.includes("CORN") ||
    s.includes("WHEAT") ||
    s.includes("SOYBEAN") ||
    s.includes("PLATINUM") ||
    s.includes("PALLADIUM")
  ) {
    return "commodities";
  }

  return "stocks";
}

const MARKET_SEEDS = {
  forex: {
    EURUSD: 1.084,
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
  },
  commodities: {
    GOLD: 2400,
    SILVER: 29,
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

function generateBasePrice(symbol = "") {
  const s = normalizeSymbol(symbol);
  const compact = compactSymbol(symbol);
  const market = detectMarket(s);

  for (const group of Object.values(MARKET_SEEDS)) {
    if (Number.isFinite(group[compact])) return Number(group[compact]);
  }

  switch (market) {
    case "crypto":
      return 1 + Math.random() * 70000;
    case "forex":
      return 0.5 + Math.random() * 2;
    case "indices":
      return 1000 + Math.random() * 50000;
    case "commodities":
      return 10 + Math.random() * 3000;
    default:
      return 5 + Math.random() * 1000;
  }
}

function getVolatility(symbol = "") {
  const market = detectMarket(symbol);

  switch (market) {
    case "crypto":
      return 0.01;
    case "forex":
      return 0.0015;
    case "indices":
      return 0.004;
    case "commodities":
      return 0.005;
    default:
      return 0.006;
  }
}

function writePrice(symbol, price, raw = null) {
  const clean = normalizeSymbol(symbol);
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
  global.marketQuotes[clean] = {
    symbol: clean,
    price: numeric,
    bid: Number(payload.bid ?? numeric),
    ask: Number(payload.ask ?? numeric),
    updatedAt: payload.updatedAt,
    raw,
  };

  try {
    if (priceHandler?.prices instanceof Map) {
      priceHandler.prices.set(clean, payload);
    } else if (priceHandler?.prices && typeof priceHandler.prices === "object") {
      priceHandler.prices[clean] = payload;
    }
  } catch {}

  return true;
}

global.writePrice = global.writePrice || writePrice;

global.getPriceStore =
  global.getPriceStore ||
  function () {
    return global.marketQuotes || {};
  };

global.getFakePrice =
  global.getFakePrice ||
  function (symbol) {
    const clean = normalizeSymbol(symbol);
    if (!clean) return null;

    const existing =
      Number(global.priceCache?.[clean]) ||
      Number(global.priceMeta?.[clean]?.price);

    if (Number.isFinite(existing) && existing > 0) return existing;

    const base = Number(generateBasePrice(clean));
    const safeBase =
      Number.isFinite(base) && base > 0
        ? base
        : Number((50 + Math.random() * 1000).toFixed(6));

    writePrice(clean, safeBase, { source: "seed" });
    return safeBase;
  };

global.forcePriceExists =
  global.forcePriceExists ||
  function (symbol) {
    const clean = normalizeSymbol(symbol);
    if (!clean) return null;

    const current =
      Number(global.priceCache?.[clean]) ||
      Number(global.priceMeta?.[clean]?.price);

    if (Number.isFinite(current) && current > 0) return current;

    const forced = global.getFakePrice(clean);
    if (Number.isFinite(forced) && forced > 0) return forced;

    const fallback = Number((50 + Math.random() * 1000).toFixed(6));
    writePrice(clean, fallback, { source: "force-fallback" });
    return fallback;
  };

global.updatePriceStore =
  global.updatePriceStore ||
  function (symbol, price) {
    return writePrice(
      symbol,
      price,
      global.priceMeta?.[normalizeSymbol(symbol)]?.raw || null
    );
  };

global.getMarketPrice =
  global.getMarketPrice ||
  function (symbol) {
    const clean = normalizeSymbol(symbol);
    if (!clean) return null;
    const cached =
      Number(global.priceCache?.[clean]) ||
      Number(global.priceMeta?.[clean]?.price);
    if (Number.isFinite(cached) && cached > 0) return cached;
    return global.getFakePrice(clean);
  };

function seedInitialSymbols() {
  for (const group of Object.values(MARKET_SEEDS || {})) {
    for (const [sym, px] of Object.entries(group || {})) {
      const price = Number(px);
      if (!Number.isFinite(price) || price <= 0) continue;
      writePrice(sym, price, { source: "seed" });
    }
  }
}
seedInitialSymbols();

setInterval(() => {
  try {
    const keys = Object.keys(global.priceCache || {});
    for (const symbol of keys) {
      const current = Number(global.priceCache[symbol]);
      if (!Number.isFinite(current) || current <= 0) continue;

      const vol = Number(getVolatility(symbol)) || 0.001;
      const drift = (Math.random() - 0.5) * vol;
      let next = current * (1 + drift);
      next = Math.max(next, 0.0000001);
      const finalPrice = Number(next.toFixed(6));
      writePrice(symbol, finalPrice, global.priceMeta?.[symbol]?.raw || null);
    }
  } catch (err) {
    console.error("Fake market error:", err);
  }
}, 1000);

function syncMarketQuotesFromPriceStore() {
  global.marketQuotes = global.marketQuotes || {};
  for (const [symbol, value] of Object.entries(global.priceCache || {})) {
    const price = Number(value);
    if (!Number.isFinite(price) || price <= 0) continue;

    global.marketQuotes[symbol] = {
      symbol,
      price,
      bid: Number(global.priceMeta?.[symbol]?.bid ?? price),
      ask: Number(global.priceMeta?.[symbol]?.ask ?? price),
      updatedAt: global.priceMeta?.[symbol]?.updatedAt || Date.now(),
      raw: global.priceMeta?.[symbol]?.raw || null,
    };
  }
}

function getPriceStore() {
  syncMarketQuotesFromPriceStore();
  return global.getPriceStore();
}

function extractQuotePrice(item = {}) {
  const direct =
    toNumber(item.price) ??
    toNumber(item.last) ??
    toNumber(item.close) ??
    toNumber(item.value) ??
    toNumber(item.mark) ??
    toNumber(item.mid);

  if (Number.isFinite(direct) && direct > 0) return direct;

  const ask = toNumber(item.ask);
  const bid = toNumber(item.bid);

  if (Number.isFinite(ask) && Number.isFinite(bid) && ask > 0 && bid > 0) {
    return (ask + bid) / 2;
  }

  return null;
}

function findBestPriceMatch(symbol, store = {}) {
  try {
    const target = compactSymbol(symbol);
    if (!target) return null;

    for (const [key, item] of Object.entries(store || {})) {
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
        return (
          c === target ||
          c.includes(target) ||
          target.includes(c) ||
          sameMarketSymbol(c, target)
        );
      });

      if (matched) return item;
    }

    return null;
  } catch (err) {
    console.error("findBestPriceMatch error:", err);
    return null;
  }
}

function getCurrentPriceForSymbol(symbol) {
  const target = compactSymbol(symbol);
  if (!target) return null;

  const store = getPriceStore();
  const match = findBestPriceMatch(symbol, store) || store?.[normalizeSymbol(symbol)];

  if (match) {
    const px = extractQuotePrice(match);
    if (Number.isFinite(px) && px > 0) return px;
  }

  for (const [key, item] of Object.entries(store || {})) {
    const px = extractQuotePrice(item);
    if (!Number.isFinite(px) || px <= 0) continue;
    if (compactSymbol(key) === target) return px;
  }

  return null;
}

function buildMarketPayload() {
  const store = getPriceStore();
  const quotes = Object.entries(store || {})
    .map(([symbol, value]) => safeNormalizeQuote(symbol, value))
    .filter(Boolean);

  return {
    ok: true,
    count: quotes.length,
    quotes,
    data: quotes,
    items: quotes,
    latest: quotes[0] || null,
  };
}

/* ======================================================
   MODELS / ACCOUNTS
====================================================== */

function isClosedPosition(p = {}) {
  const status = String(p.status || p.state || p.positionStatus || "")
    .toLowerCase()
    .trim();
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
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    currentPrice = getCurrentPriceForSymbol(position.symbol);
  }
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    currentPrice = entryPrice;
  }

  const qty = Number(position.qty ?? position.quantity ?? position.amount ?? position.positionSize ?? 0) || 0;
  const side = normalizeSide(position.side || position.direction || position.positionSide);
  const sign = side === "SELL" ? -1 : 1;

  const pnl = isClosedPosition(position)
    ? Number(position.realizedPnl ?? position.pnl ?? 0) || 0
    : (currentPrice - entryPrice) * qty * sign;

  return {
    ...position,
    entryPrice,
    currentPrice,
    qty,
    pnl,
    unrealizedPnl: pnl,
    isOpen: !isClosedPosition(position),
  };
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
    });
  }
  return wallet;
}

function normalizeWalletSnapshot(wallet, openPnl = 0) {
  const balanceOwn = Number(wallet?.balanceOwn ?? wallet?.balance ?? 0) || 0;
  const credit = Number(wallet?.credit ?? 0) || 0;
  const marginUsed = Math.max(Number(wallet?.marginUsed ?? 0) || 0, 0);
  const pnl = Number(openPnl ?? 0) || 0;

  const equity = balanceOwn + marginUsed + pnl + credit;
  const freeMargin = Math.max(balanceOwn + pnl + credit, 0);
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
    currency: wallet?.currency || "USD",
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

const Transaction =
  mongoose.models.Transaction || mongoose.model("Transaction", transactionSchema);

async function recordTransaction({
  user,
  type,
  amount = 0,
  status = "completed",
  note = "",
  balanceBefore = 0,
  balanceAfter = 0,
  meta = {},
  source = "server.js",
}) {
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
  return await Transaction.find({ user: userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()
    .exec()
    .catch(() => []);
}

async function loadOpenPositionsForUser(userId) {
  const rows = await Position.find({
    user: userId,
    status: { $in: ["OPEN", "open", "Open"] },
  })
    .sort({ createdAt: -1 })
    .lean()
    .exec()
    .catch(() => []);

  return (rows || []).map((p) => {
    try {
      return annotatePosition(p);
    } catch {
      return p;
    }
  });
}

async function loadAllPositionsForUser(userId) {
  const rows = await Position.find({ user: userId })
    .sort({ createdAt: -1 })
    .lean()
    .exec()
    .catch(() => []);

  return (rows || []).map((p) => {
    try {
      return annotatePosition(p);
    } catch {
      return p;
    }
  });
}

async function buildAccountForUser(userDoc) {
  const wallet = await getWalletDocForUser(userDoc._id);
  const openPositions = await loadOpenPositionsForUser(userDoc._id);
  const allPositions = await loadAllPositionsForUser(userDoc._id);
  const recentTransactions = await loadTransactionsForUser(userDoc._id, 20);
  const walletSnapshot = wallet?.toObject ? wallet.toObject() : wallet;
  const balance = getEffectiveBalance(userDoc, walletSnapshot);
  const openPnl = (openPositions || []).reduce(
    (sum, p) => sum + (Number(p.unrealizedPnl ?? p.pnl ?? 0) || 0),
    0
  );

  const normalizedWallet = normalizeWalletSnapshot(
    walletSnapshot
      ? { ...walletSnapshot, balanceOwn: balance, balance }
      : { balanceOwn: balance, balance },
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
      currency: userDoc.currency || walletSnapshot?.currency || "USD",
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
      currency: userDoc?.currency || "USD",
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
      currency: userDoc?.currency || "USD",
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
  try {
    return await buildAccountForUser(userDoc);
  } catch (err) {
    console.error("buildAccountForUser failed:", err);
    return buildEmptyAccountPayload(userDoc);
  }
}

async function safeLoadOpenPositionsForUser(userId) {
  try {
    const rows = await Position.find({
      user: userId,
      status: { $in: ["OPEN", "open", "Open"] },
    })
      .sort({ createdAt: -1 })
      .lean()
      .exec()
      .catch(() => []);

    return (rows || []).map((p) => {
      try {
        return annotatePosition(p);
      } catch {
        return p;
      }
    });
  } catch (err) {
    console.error("safeLoadOpenPositionsForUser failed:", err);
    return [];
  }
}

async function safeLoadAllPositionsForUser(userId) {
  try {
    const rows = await Position.find({ user: userId })
      .sort({ createdAt: -1 })
      .lean()
      .exec()
      .catch(() => []);

    return (rows || []).map((p) => {
      try {
        return annotatePosition(p);
      } catch {
        return p;
      }
    });
  } catch (err) {
    console.error("safeLoadAllPositionsForUser failed:", err);
    return [];
  }
}

async function safeLoadTransactionsForUser(userId, limit = 50) {
  try {
    return await loadTransactionsForUser(userId, limit);
  } catch (err) {
    console.error("safeLoadTransactionsForUser failed:", err);
    return [];
  }
}

async function safeGetUserFromBearer(req) {
  try {
    return await getUserDocFromBearer(req);
  } catch (err) {
    console.error("getUserDocFromBearer failed:", err);
    return null;
  }
}

function getEffectivePriceForSymbol(symbol, fallback = null) {
  const direct = Number(global.priceCache?.[normalizeSymbol(symbol)]);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const market = getCurrentPriceForSymbol(symbol);
  if (Number.isFinite(market) && market > 0) return market;

  const fake = global.getFakePrice?.(symbol);
  if (Number.isFinite(fake) && fake > 0) return fake;

  if (Number.isFinite(fallback) && fallback > 0) return fallback;
  return null;
}

const openTradeLocks = new Map();
const activeOrders = new Set();
const liveSyncTimers = new Map();

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

  const t = setTimeout(() => {
    activeOrders.delete(key);
  }, ttlMs);

  if (t && typeof t.unref === "function") t.unref();
  return true;
}

function releaseActiveOrder(key) {
  activeOrders.delete(key);
}

function scheduleLivePnLSync(symbol) {
  const key = compactSymbol(symbol);
  if (!key) return;

  const prev = liveSyncTimers.get(key);
  if (prev) clearTimeout(prev);

  const timer = setTimeout(async () => {
    liveSyncTimers.delete(key);
    try {
      await syncLivePnLForSymbol(symbol);
    } catch (e) {
      console.warn("syncLivePnL error:", e?.message || e);
    }
  }, 120);

  if (timer?.unref) timer.unref();
  liveSyncTimers.set(key, timer);
}

async function emitStateUpdates(userId, accountPayload = null, positions = null, transaction = null) {
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

async function syncLivePnLForSymbol(symbol) {
  try {
    const targetCompact = compactSymbol(symbol);
    if (!targetCompact) return;

    const currentPrice = getCurrentPriceForSymbol(symbol);
    if (!currentPrice || !Number.isFinite(currentPrice) || currentPrice <= 0) return;

    const openRows = await Position.find({
      status: { $in: ["OPEN", "open"] },
    }).lean();

    if (!openRows.length) return;

    const matchedRows = openRows.filter((p) => {
      const candidates = [
        p.symbol,
        p.tvSymbol,
        p.selectedSymbol,
        p.chartSymbol,
        p.instrument,
        p.marketSymbol,
        p.market,
        p.ticker,
        p.asset,
      ].filter(Boolean);

      return candidates.some((candidate) => {
        const c = compactSymbol(candidate);
        return (
          c === targetCompact ||
          c.includes(targetCompact) ||
          targetCompact.includes(c) ||
          sameMarketSymbol(c, targetCompact)
        );
      });
    });

    if (!matchedRows.length) return;

    const updateTime = new Date();

    for (const pos of matchedRows) {
      const livePnl = computePositionPnl(pos, currentPrice);

      await Position.updateOne(
        { _id: pos._id },
        {
          $set: {
            currentPrice,
            pnl: livePnl,
            unrealizedPnl: livePnl,
            updatedAt: updateTime,
          },
        }
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

async function applyCloseToPosition({
  user,
  positionDoc,
  currentPrice,
  source = "api/trade/close",
}) {
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
  wallet.balanceOwn = balanceBefore + reservedMargin + realizedPnl;
  wallet.balance = wallet.balanceOwn;
  wallet.equity = wallet.balanceOwn + wallet.marginUsed + credit;
  wallet.freeMargin = Math.max(wallet.balanceOwn + credit, 0);
  wallet.marginLevel = wallet.marginUsed > 0 ? (wallet.equity / wallet.marginUsed) * 100 : 0;
  wallet.updatedAt = new Date();
  await wallet.save();

  user.balance = wallet.balanceOwn;
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
    meta: {
      positionId: String(position._id),
      symbol,
      side,
      qty,
      entryPrice,
      closePrice: closePx,
      marginReleased: reservedMargin,
      realizedPnl,
    },
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

function resolveOrderPrice(body = {}, symbol = "") {
  const direct = normalizePrice(body);
  if (direct) return direct;

  const candidates = [
    body.currentPrice,
    body.current_price,
    body.lastPrice,
    body.last_price,
    body.tvPrice,
    body.tv_price,
    body.entry,
    body.entryPrice,
    body.entry_price,
    body.marketPrice,
    body.market_price,
    body.quotePrice,
    body.quote_price,
    body.executionPrice,
    body.execution_price,
  ];

  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const market = getCurrentPriceForSymbol(symbol);
  if (market && Number.isFinite(market) && market > 0) return market;

  return null;
}

/* ======================================================
   HEALTH / MAIL
====================================================== */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    env: process.env.NODE_ENV || "dev",
    emailProvider: process.env.RESEND_API_KEY
      ? "resend"
      : process.env.EMAIL_USER || process.env.SMTP_USER
        ? "smtp"
        : "none",
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
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
          <h2>Hola ${name}, verifica tu cuenta</h2>
          <p>Haz clic en el botón de abajo para activar tu cuenta:</p>
          <p><a href="${verificationLink}" style="display:inline-block;background:#d4af37;color:#000;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold">Verificar cuenta</a></p>
          <p>Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
          <p>${verificationLink}</p>
        </div>
      `,
    });
  } catch (err) {
    console.error("[MAIL] sendVerificationEmail error:", err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
};

app.post("/api/_send_test_email", async (req, res) => {
  const to = (req.body && req.body.to) || process.env.SENDER_EMAIL;
  if (!to)
    return res.status(400).json({
      ok: false,
      message: "Necesitas enviar 'to' en el body o configurar SENDER_EMAIL",
    });
  const subject = req.body.subject || "Prueba de correo - Leones Broker";
  const html =
    req.body.html ||
    `<p>Esto es una prueba desde el servidor de Leones Broker. Si recibes este correo, Resend/SMTP está funcionando.</p>`;
  try {
    const r = await sendEmail({ to, subject, html });
    if (r.ok)
      return res.json({
        ok: true,
        message: "Correo enviado",
        provider: r.provider,
        result: r.result || r.info || r.resp,
      });
    return res.status(500).json({
      ok: false,
      message: "No se pudo enviar correo",
      error: r.error,
    });
  } catch (err) {
    console.error("test email error:", err);
    return res.status(500).json({
      ok: false,
      message: "Error interno enviando correo",
      error: err && err.message ? err.message : String(err),
    });
  }
});

/* ======================================================
   MARKET ROUTES
====================================================== */

const SAMPLE_SYMBOLS = [
  { symbol: "BINANCE:BTCUSDT", label: "BTC/USDT", market: "Crypto" },
  { symbol: "BINANCE:ETHUSDT", label: "ETH/USDT", market: "Crypto" },
  { symbol: "OANDA:EUR_USD", label: "EUR/USD", market: "Forex" },
  { symbol: "NASDAQ:AAPL", label: "AAPL", market: "Stocks" },
  { symbol: "INDEX:SPX", label: "S&P 500", market: "Indices" },
  { symbol: "BINANCE:BCHUSDT", label: "BCH/USDT", market: "Crypto" },
  { symbol: "BINANCE:ADAUSDT", label: "ADA/USDT", market: "Crypto" },
  { symbol: "FOREX:USDJPY", label: "USD/JPY", market: "Forex" },
];

function buildQuotesArray() {
  const store = getPriceStore();
  const keys = Object.keys(store);

  if (keys.length) {
    return keys
      .map((symbol) => safeNormalizeQuote(symbol, store[symbol] || {}))
      .filter(Boolean);
  }

  return SAMPLE_SYMBOLS.map((s) =>
    safeNormalizeQuote(s.symbol, {
      label: s.label,
      market: s.market,
      price: null,
      updatedAt: new Date().toISOString(),
    })
  ).filter(Boolean);
}

function buildMarketPayload() {
  const quotes = buildQuotesArray();
  return {
    ok: true,
    count: quotes.length,
    quotes,
    data: quotes,
    items: quotes,
    latest: quotes[0] || null,
  };
}

app.get("/api/markets", (req, res) =>
  res.json({
    markets: ["Crypto", "Stocks", "Forex", "Indices", "Futures", "Bonds"],
  })
);

app.get("/api/market/list", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/market/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/markets/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/api/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/api/markets", (req, res) =>
  res.json({ markets: ["Crypto", "Stocks", "Forex", "Indices"] })
);

app.get("/api/quotes", (req, res) => {
  try {
    const quotes = getPriceStore();
    return res.status(200).json({
      ok: true,
      quotes,
      data: quotes,
      count: Object.keys(quotes).length,
      serverTime: Date.now(),
    });
  } catch (err) {
    console.error("❌ /api/quotes:", err);
    return res.status(200).json({
      ok: true,
      quotes: {},
      data: {},
      count: 0,
      fallback: true,
      serverTime: Date.now(),
    });
  }
});

app.get("/api/market/quotes", (req, res) => {
  try {
    return res.status(200).json(buildMarketPayload());
  } catch (err) {
    console.error("❌ /api/market/quotes:", err);
    return res.status(200).json({
      ok: true,
      quotes: [],
      data: [],
      count: 0,
      fallback: true,
      serverTime: Date.now(),
    });
  }
});

app.get("/api/latest", (req, res) => {
  try {
    const rawSymbol =
      req.query.symbol ||
      req.query.tvSymbol ||
      req.query.selectedSymbol ||
      "";
    const symbol = normalizeSymbol(String(rawSymbol || "").trim().toUpperCase());

    if (!symbol) {
      return res.json({
        ok: true,
        symbol: null,
        price: null,
        currentPrice: null,
        close: null,
        last: null,
        updatedAt: new Date().toISOString(),
        message: "symbol_missing",
      });
    }

    let price = getCurrentPriceForSymbol(symbol);

    if (!Number.isFinite(price) || price <= 0) {
      const store = getPriceStore();
      const found = findBestPriceMatch(symbol, store);
      if (found) price = extractQuotePrice(found);
    }

    if (!Number.isFinite(price) || price <= 0) {
      return res.json({
        ok: false,
        error: "price_not_found",
        symbol,
        price: null,
        currentPrice: null,
        close: null,
        last: null,
        updatedAt: new Date().toISOString(),
      });
    }

    return res.json({
      ok: true,
      symbol,
      price,
      currentPrice: price,
      close: price,
      last: price,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("/api/latest error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/market/latest", (req, res) => {
  try {
    const quotes = getPriceStore();
    return res.status(200).json({
      ok: true,
      prices: quotes,
      data: quotes,
      latest: quotes,
      count: Object.keys(quotes).length,
      serverTime: Date.now(),
    });
  } catch (err) {
    console.error("❌ /api/market/latest:", err);
    return res.status(200).json({
      ok: true,
      prices: {},
      data: {},
      latest: {},
      count: 0,
      fallback: true,
      serverTime: Date.now(),
    });
  }
});

app.get("/api/market/polygon/quotes", (req, res) => {
  try {
    const quotes = Object.values(getPriceStore()).filter(Boolean);
    return res.status(200).json({
      ok: true,
      quotes,
      data: quotes,
      count: quotes.length,
      serverTime: Date.now(),
    });
  } catch (err) {
    console.error("❌ /api/market/polygon/quotes:", err);
    return res.status(200).json({
      ok: true,
      quotes: [],
      data: [],
      count: 0,
      fallback: true,
      serverTime: Date.now(),
    });
  }
});

app.get("/api/market/polygon/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/symbols", (req, res) => {
  try {
    const prices = getPriceStore();
    if (prices && Object.keys(prices).length) {
      return res.json(
        Object.keys(prices).map((k) => ({
          symbol: k,
          label: (k.split(":").pop() || k).replace("_", "/"),
          market: prices[k]?.market || "Unknown",
        }))
      );
    }
    return res.json(SAMPLE_SYMBOLS);
  } catch (err) {
    console.error("api/symbols error:", err);
    return res.json(SAMPLE_SYMBOLS);
  }
});

app.get("/api/price", async (req, res) => {
  try {
    const rawSymbol = String(
      req.query.symbol || req.query.tvSymbol || req.query.selectedSymbol || ""
    );
    const symbol = normalizeSymbol(rawSymbol);

    if (!symbol) {
      return res.status(400).json({ ok: false, error: "symbol_required" });
    }

    global.forcePriceExists(symbol);

    let found = null;
    try {
      const store = getPriceStore();
      found = findBestPriceMatch(symbol, store || {}) || store[symbol] || null;
    } catch (err) {
      console.warn("❌ STORE SEARCH ERROR:", err?.message || err);
    }

    let price = null;

    if (found) {
      price =
        Number(found?.price) ||
        Number(found?.currentPrice) ||
        Number(found?.lastPrice) ||
        Number(found?.last) ||
        Number(found?.close) ||
        Number(found?.raw?.price) ||
        Number(found?.raw?.p) ||
        Number(found?.raw?.lp) ||
        Number(found?.raw?.last) ||
        Number(found?.raw?.close) ||
        Number(found?.bid) ||
        Number(found?.ask) ||
        null;
    }

    if (!price || !Number.isFinite(price) || price <= 0) {
      price = global.getFakePrice?.(symbol);
      if (price && Number.isFinite(price) && price > 0) {
        writePrice(symbol, price, found?.raw || null);
      }
    }

    if (!price || !Number.isFinite(price) || price <= 0) {
      try {
        const fallback = await fetchPolygonLastPrice(symbol);
        const fallbackPrice = Number(fallback?.price);
        if (Number.isFinite(fallbackPrice) && fallbackPrice > 0) {
          price = fallbackPrice;
          writePrice(symbol, fallbackPrice, fallback?.raw || null);
        }
      } catch (err) {
        console.warn("❌ FALLBACK ERROR:", err?.message || err);
      }
    }

    if (!price || !Number.isFinite(price) || price <= 0) {
      price =
        global.forcePriceExists(symbol) ||
        global.getFakePrice?.(symbol) ||
        50 + Math.random() * 1000;
      writePrice(symbol, price, found?.raw || null);
    }

    return res.json({
      ok: true,
      symbol,
      price: Number(price),
      currentPrice: Number(price),
      last: Number(price),
      close: Number(price),
      updatedAt: found?.updatedAt || new Date().toISOString(),
    });
  } catch (err) {
    console.error("Error /api/price:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ======================================================
   ADMIN ROUTES
====================================================== */

async function requireAdmin(req, res, next) {
  try {
    const key = String(req.headers["x-admin-api-key"] || req.headers["x-admin-key"] || "");
    if (process.env.ADMIN_API_KEY && key && key === process.env.ADMIN_API_KEY) return next();

    const auth = req.headers.authorization || req.headers.Authorization || "";
    const token = String(auth).toLowerCase().startsWith("bearer ")
      ? String(auth).split(" ")[1]
      : "";

    if (!token || !process.env.JWT_SECRET) {
      return res.status(401).json({ ok: false, error: "Admin unauthorized" });
    }

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

app.post("/api/admin/deposit", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const userId = body.userId || body.user || body.clientId || null;
    const amount = Number(body.amount ?? body.depositAmount ?? body.balance ?? 0);
    const leverage = body.leverage !== undefined ? Number(body.leverage) : null;
    const note = String(body.note || body.description || "Admin deposit").trim();
    const currency = String(body.currency || "USD").trim();

    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId_required" });
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, error: "amount_required" });
    }

    const user = await User.findById(userId).catch(() => null);
    if (!user) {
      return res.status(404).json({ ok: false, error: "user_not_found" });
    }

    const wallet = await getWalletDocForUser(user._id);
    const balanceBefore = Number(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) || 0;

    wallet.balanceOwn = balanceBefore + amount;
    wallet.balance = wallet.balanceOwn;
    wallet.currency = currency || wallet.currency || "USD";

    if (Number.isFinite(leverage) && leverage > 0) {
      wallet.leverageFactor = leverage;
      user.leverage = leverage;
    }

    wallet.marginUsed = Number(wallet.marginUsed ?? 0) || 0;
    wallet.equity = wallet.balanceOwn + wallet.marginUsed + Number(wallet.credit ?? 0);
    wallet.freeMargin = Math.max(wallet.balanceOwn + Number(wallet.credit ?? 0), 0);
    wallet.updatedAt = new Date();

    await wallet.save();

    user.balance = wallet.balanceOwn;
    user.currency = currency || user.currency || "USD";

    if (Number.isFinite(leverage) && leverage > 0) {
      user.leverage = leverage;
    }

    await user.save();

    const tx = await recordTransaction({
      user,
      type: "deposit",
      amount,
      status: "completed",
      note,
      balanceBefore,
      balanceAfter: wallet.balanceOwn,
      meta: {
        source: "admin-panel",
        method: body.method || "deposit",
        currency,
        leverage: wallet.leverageFactor,
      },
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
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message || "Error interno",
    });
  }
});

app.post("/api/admin/withdraw", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const userId = body.userId || body.user || body.clientId || null;
    const amount = Number(body.amount ?? body.withdrawAmount ?? 0);
    const note = String(body.note || body.description || "Admin withdrawal").trim();

    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId_required" });
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, error: "amount_required" });
    }

    const user = await User.findById(userId).catch(() => null);
    if (!user) {
      return res.status(404).json({ ok: false, error: "user_not_found" });
    }

    const wallet = await getWalletDocForUser(user._id);
    const balanceBefore = Number(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) || 0;

    if (balanceBefore < amount) {
      return res.status(400).json({
        ok: false,
        error: "insufficient_balance",
        message: "Saldo insuficiente",
      });
    }

    wallet.balanceOwn = balanceBefore - amount;
    wallet.balance = wallet.balanceOwn;
    wallet.marginUsed = Number(wallet.marginUsed ?? 0) || 0;
    wallet.equity = wallet.balanceOwn + wallet.marginUsed + Number(wallet.credit ?? 0);
    wallet.freeMargin = Math.max(wallet.balanceOwn + Number(wallet.credit ?? 0), 0);
    wallet.updatedAt = new Date();

    await wallet.save();

    user.balance = wallet.balanceOwn;
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
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message || "Error interno",
    });
  }
});

app.get("/api/admin/transactions", requireAdmin, async (req, res) => {
  try {
    const userId = req.query.userId || null;
    const limit = Math.min(Number(req.query.limit || 100) || 100, 500);

    const txs = userId
      ? await safeLoadTransactionsForUser(userId, limit)
      : await Transaction.find({})
          .sort({ createdAt: -1 })
          .limit(limit)
          .lean()
          .exec()
          .catch(() => []);

    return res.json({
      ok: true,
      count: txs.length,
      transactions: txs,
      data: txs,
      items: txs,
    });
  } catch (err) {
    console.error("/api/admin/transactions error:", err);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message || "Error interno",
    });
  }
});

/* ======================================================
   TRADING CORE
====================================================== */

app.post("/api/trade/open", async (req, res) => {
  let lockKey = null;

  try {
    const user = await getUserDocFromBearer(req);
    if (!user) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const body = req.body || {};
    const symbol = normalizePositionSymbol(body);
    const side = normalizeSide(body.side);
    const qty = normalizeQty(body);

    if (!symbol || !side || !qty) {
      return res.status(400).json({ ok: false, error: "invalid_params" });
    }

    lockKey = makeOpenLockKey(user._id, symbol, side, qty);

    if (!withOpenLock(lockKey, 2500) || !withActiveOrder(lockKey, 2500)) {
      return res.status(429).json({ ok: false, error: "duplicate_order_blocked" });
    }

    const wallet = await getWalletDocForUser(user._id);
    const balanceOwn = Number(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) || 0;
    const credit = Number(wallet.credit ?? 0) || 0;
    const marginUsed = Number(wallet.marginUsed ?? 0) || 0;
    const leverage = Math.max(Number(wallet.leverageFactor ?? user.leverage ?? 1) || 1, 1);

    let price = null;

    const directCandidates = [
      body.price,
      body.entryPrice,
      body.currentPrice,
      body.marketPrice,
      body.lastPrice,
      body.close,
      body.ask,
      body.bid,
    ];

    for (const value of directCandidates) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) {
        price = n;
        break;
      }
    }

    if (!Number.isFinite(price) || price <= 0) {
      price = getEffectivePriceForSymbol(symbol);
    }

    if (!Number.isFinite(price) || price <= 0) {
      const store = getPriceStore();
      const found = findBestPriceMatch(symbol, store);
      if (found) {
        const extracted =
          Number(found?.price) ||
          Number(found?.currentPrice) ||
          Number(found?.lastPrice) ||
          Number(found?.close) ||
          Number(found?.last);
        if (Number.isFinite(extracted) && extracted > 0) price = extracted;
      }
    }

    if (!Number.isFinite(price) || price <= 0) {
      const generated =
        typeof generateBasePrice === "function" ? Number(generateBasePrice(symbol)) : 100;
      if (Number.isFinite(generated) && generated > 0) {
        price = generated;
        writePrice(symbol, price, { source: "generated" });
      }
    }

    if (!Number.isFinite(price) || price <= 0) price = 100;
    price = Number(price);

    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({
        ok: false,
        error: "price_invalid",
        symbol,
        receivedPrice: price,
      });
    }

    const notional = Math.abs(qty * price);
    let requiredMargin = notional / leverage;
    if (!Number.isFinite(requiredMargin) || requiredMargin <= 0) requiredMargin = 1;

    const freeMargin = Number(balanceOwn + credit - marginUsed) || 0;
    if (freeMargin < requiredMargin) {
      return res.status(400).json({ ok: false, error: "insufficient_margin" });
    }

    wallet.balanceOwn = Math.max(balanceOwn - requiredMargin, 0);
    wallet.balance = wallet.balanceOwn;
    wallet.marginUsed = marginUsed + requiredMargin;
    wallet.equity = wallet.balanceOwn + wallet.marginUsed + credit;
    wallet.freeMargin = Math.max(wallet.balanceOwn + credit - wallet.marginUsed, 0);
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
    });

    const account = await safeBuildAccountForUser(user);
    const annotatedPosition = annotatePosition(position.toObject ? position.toObject() : position);

    emitStateUpdates(user._id, account, [annotatedPosition], null);

    try {
      scheduleLivePnLSync(symbol);
    } catch {}

    return res.json({
      ok: true,
      msg: "OPENED",
      price,
      position,
      wallet: account.wallet,
      account: account.account,
    });
  } catch (err) {
    console.error("/api/trade/open error:", err);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message || "Error interno",
    });
  } finally {
    if (lockKey) {
      try {
        releaseOpenLock(lockKey);
      } catch {}
      try {
        releaseActiveOrder(lockKey);
      } catch {}
    }
  }
});

app.post("/api/trade/close", async (req, res) => {
  let lockKey = null;

  try {
    const user = await getUserDocFromBearer(req);
    if (!user) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { positionId } = req.body || {};
    if (!positionId) {
      return res.status(400).json({ ok: false, error: "positionId_required" });
    }

    lockKey = makeCloseLockKey(user._id, positionId);

    if (!withOpenLock(lockKey, 2500)) {
      return res.status(429).json({ ok: false, error: "duplicate_close_blocked" });
    }

    const position = await Position.findOne({
      _id: positionId,
      user: user._id,
      status: { $in: ["OPEN", "open", "Open"] },
    });

    if (!position) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    const body = req.body || {};
    let price = null;

    const directCandidates = [
      body.price,
      body.currentPrice,
      body.closePrice,
      body.marketPrice,
      body.lastPrice,
    ];

    for (const value of directCandidates) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) {
        price = n;
        break;
      }
    }

    if (!Number.isFinite(price) || price <= 0) {
      price = getEffectivePriceForSymbol(position.symbol);
    }

    if (!Number.isFinite(price) || price <= 0) {
      price = Number(position.currentPrice) || Number(position.entryPrice) || 100;
    }

    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ ok: false, error: "price_invalid" });
    }

    const result = await applyCloseToPosition({
      user,
      positionDoc: position,
      currentPrice: price,
      source: "api/trade/close",
    });

    try {
      scheduleLivePnLSync(position.symbol);
    } catch {}

    return res.json({ ok: true, msg: "CLOSED", ...result });
  } catch (err) {
    console.error("/api/trade/close error:", err);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message || "Error interno",
    });
  } finally {
    if (lockKey) {
      try {
        releaseOpenLock(lockKey);
      } catch {}
    }
  }
});

app.get("/api/trade/positions", async (req, res) => {
  try {
    const user = await safeGetUserFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const positions = await safeLoadOpenPositionsForUser(user._id);
    return res.json({
      ok: true,
      positions,
      data: positions,
      items: positions,
      count: positions.length,
    });
  } catch (err) {
    console.error("/api/trade/positions error", err);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message || "Error interno",
    });
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
    return res.json({
      ok: true,
      count: transactions.length,
      transactions,
      data: transactions,
      items: transactions,
    });
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
    return res.json({
      ok: true,
      positions,
      data: positions,
      items: positions,
      count: positions.length,
    });
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
    return res.json({
      ok: true,
      positions,
      data: positions,
      items: positions,
      count: positions.length,
    });
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
    return res.json({
      ok: true,
      positions,
      data: positions,
      items: positions,
      count: positions.length,
    });
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
    return res.json({
      ok: true,
      positions,
      data: positions,
      items: positions,
      count: positions.length,
    });
  } catch (e) {
    console.error("/api/posiciones/all error", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/* ======================================================
   SOCKET.IO
====================================================== */

let polygonSocket = null;

function extractSymbol(data) {
  const raw =
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
    "";
  return normalizeSymbol(raw);
}

function extractPrice(data = {}) {
  const candidates = [
    data?.price,
    data?.last,
    data?.close,
    data?.currentPrice,
    data?.bid,
    data?.ask,
    data?.p,
    data?.lp,
  ];

  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const symbol = extractSymbol(data);

  if (symbol && global.priceCache?.[symbol]) {
    const cached = Number(global.priceCache[symbol]);
    if (Number.isFinite(cached) && cached > 0) return cached;
  }

  if (symbol && typeof global.getFakePrice === "function") {
    const fake = Number(global.getFakePrice(symbol));
    if (Number.isFinite(fake) && fake > 0) return fake;
  }

  return null;
}

function safeStorePrice(symbol, price, rawData = null) {
  return writePrice(symbol, price, rawData);
}

async function fetchPolygonLastPrice(symbol) {
  try {
    const clean = normalizeSymbol(symbol);
    if (!clean || !process.env.POLYGON_API_KEY) return null;

    const polygonSymbol = toPolygonSymbol(clean);
    if (!polygonSymbol) return null;

    const url = `https://api.polygon.io/v2/last/trade/${encodeURIComponent(
      polygonSymbol
    )}?apiKey=${encodeURIComponent(process.env.POLYGON_API_KEY)}`;

    const response = await fetch(url);
    const data = await response.json();
    const price = extractPrice(data);

    if (price && Number.isFinite(price) && price > 0) {
      return { price, raw: data, symbol: clean, polygonSymbol };
    }

    return null;
  } catch (err) {
    console.warn("❌ fetchPolygonLastPrice error:", err?.message || err);
    return null;
  }
}

async function safeAutoSubscribeDefaults() {
  if (!polygonSocket?.subscribe) return;
  const symbols = ["X:BTCUSD", "X:ETHUSD", "C:EURUSD", "AAPL", "I:SPX"];
  for (const sym of symbols) {
    try {
      polygonSocket.subscribe(sym, "trades");
    } catch (subErr) {
      console.warn("❌ AUTO SUBSCRIBE ERROR:", sym, subErr?.message || subErr);
    }
  }
}

io.on("connection", (socket) => {
  console.log("📡 Cliente conectado:", socket.id);

  try {
    socket.emit("prices_snapshot", getPriceStore());
  } catch {
    socket.emit("prices_snapshot", {});
  }

  socket.on("join_user_room", async ({ token, userId } = {}) => {
    try {
      let uid = String(userId || "").trim();
      if (!uid && token && process.env.JWT_SECRET) {
        const payload = jwt.verify(String(token), process.env.JWT_SECRET);
        uid = String(
          payload?.id || payload?.sub || payload?.userId || payload?._id || ""
        ).trim();
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
      socket.emit("prices_snapshot", getPriceStore());
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
            label: (k.split(":").pop() || k).replace("_", "/"),
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
      const cleanSymbol = normalizeSymbol(symbol);
      const polygonSymbol = toPolygonSymbol(cleanSymbol);

      if (polygonSocket?.subscribe && polygonSymbol) {
        polygonSocket.subscribe(polygonSymbol, kind || "trades");
      }

      socket.join(cleanSymbol);
    } catch (e) {
      console.warn("subscribe error:", e);
    }
  });

  socket.on("unsubscribe", ({ symbol, kind } = {}) => {
    if (!symbol) return;
    try {
      const cleanSymbol = normalizeSymbol(symbol);
      const polygonSymbol = toPolygonSymbol(cleanSymbol);

      if (polygonSocket?.unsubscribe && polygonSymbol) {
        polygonSocket.unsubscribe(polygonSymbol, kind || "trades");
      }

      socket.leave(cleanSymbol);
    } catch (e) {
      console.warn("unsubscribe error:", e);
    }
  });

  socket.on("disconnect", (reason) => {
    console.log("❌ Cliente desconectado:", socket.id, "reason:", reason);
  });
});

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
            try {
              const fallback = await fetchPolygonLastPrice(symbol);
              finalPrice = fallback?.price || null;
              if (finalPrice && Number.isFinite(finalPrice) && finalPrice > 0) {
                safeStorePrice(symbol, finalPrice, fallback.raw);
              }
            } catch (fallbackErr) {
              console.warn("❌ FALLBACK FETCH ERROR:", fallbackErr?.message || fallbackErr);
            }
          }

          if (!finalPrice || !Number.isFinite(finalPrice) || finalPrice <= 0) return;

          safeStorePrice(symbol, Number(finalPrice), data);

          if (priceHandler?.handle) {
            try {
              priceHandler.handle({ ...data, symbol, price: Number(finalPrice) });
            } catch (handlerErr) {
              console.warn("priceHandler.handle error:", handlerErr?.message || handlerErr);
            }
          }

          if (typeof updatePriceStore === "function") {
            try {
              updatePriceStore(symbol, Number(finalPrice));
            } catch (storeErr) {
              console.warn("updatePriceStore error:", storeErr?.message || storeErr);
            }
          }

          scheduleLivePnLSync(symbol);
        } catch (err) {
          console.warn("onPrice handler error:", err?.message || err);
        }
      },
      onOpen: async () => {
        try {
          await safeAutoSubscribeDefaults();
        } catch (err) {
          console.warn("❌ AUTO SUBSCRIBE FAILED:", err?.message || err);
        }
      },
      onClose: () => {
        console.log("❌ PolygonSocket cerrado");
      },
      onError: (err) => {
        console.error("❌ PolygonSocket error:", err?.message || err);
      },
    });

    const maybe = polygonSocket.connect();
    if (maybe && typeof maybe.then === "function") {
      maybe.catch((err) => {
        console.warn("❌ PolygonSocket.connect() rejected:", err?.message || err);
        polygonSocket = null;
      });
    }

    console.log("🔌 Intentando conectar PolygonSocket...");
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
  console.warn(
    `WARN: No se encontró carpeta estática entre ${staticCandidates.join(", ")}. Usando fallback '${staticDirName}'.`
  );
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

  if (normalized.startsWith("/public/js/")) {
    candidates.push(path.join(staticPath, normalized.replace(/^\/public\//, "")));
  }

  if (normalized.startsWith("/js/")) {
    candidates.push(path.join(jsDirPath, normalized.slice("/js/".length)));
    candidates.push(path.join(staticPath, normalized.replace(/^\/+/, "")));
  }

  if (normalized.startsWith("/public/")) {
    candidates.push(path.join(staticPath, normalized.replace(/^\/public\//, "")));
  }

  if (base) {
    candidates.push(path.join(staticPath, base));
    candidates.push(path.join(jsDirPath, base));
  }

  const uniqueCandidates = [...new Set(candidates)];

  return uniqueCandidates.find((p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
      return false;
    }
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

    res
      .status(404)
      .type("application/javascript; charset=utf-8")
      .send(`console.error("JS missing: ${pathname}");`);
  } catch (err) {
    console.error("Error sirviendo JS:", err);
    res
      .status(500)
      .type("application/javascript; charset=utf-8")
      .send(`console.error("JS server error");`);
  }
});

app.use("/public", express.static(staticPath));
app.use("/js", express.static(jsDirPath));
app.use(express.static(staticPath));

/* ======================================================
   NOT FOUND
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

/* =========================
   START / SHUTDOWN
========================= */

const PORT = Number(process.env.PORT) || 3000;

const server = httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on ${PORT}`);
  console.log("ENV STATUS:");
  console.log("RESEND:", !!process.env.RESEND_API_KEY);
  console.log("SENDER:", !!process.env.SENDER_EMAIL);
  console.log("MONGO:", !!process.env.MONGO_URI);
  console.log("ADMIN_API_KEY:", !!process.env.ADMIN_API_KEY);
  console.log("POLYGON:", !!process.env.POLYGON_API_KEY);
  if (!process.env.POLYGON_API_KEY)
    console.warn("⚠️ POLYGON_API_KEY no configurado — realtime limitado");
  if (!process.env.RESEND_API_KEY)
    console.warn("⚠️ Resend no configurado — emails pueden usar SMTP o simulación");
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
      try {
        global.stopRiskWatcher();
      } catch (e) {
        console.warn("stopRiskWatcher threw:", e);
      }
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
