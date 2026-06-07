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
import multer from "multer";

import { connectDB } from "./config/db.js";
import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import verificationRoutes from "./routes/verification.routes.js";
import walletRoutes from "./routes/wallet.routes.js";
import positionsRoutes from "./routes/positions.routes.js";
import tradeRoutes from "./routes/trade.routes.js";
import accountRoutes from "./routes/account.routes.js";
import passwordRoutes from "./routes/password.routes.js";
import withdrawRoutes from "./routes/withdraw.routes.js";
import { startRiskWatcher } from "./jobs/risk.job.js";

import PolygonSocket from "./sockets/polygonSocket.js";
import PriceHandler from "./utils/priceHandler.js";
import marketRoutesFactory from "./routes/market.routes.js";
import sendEmail from "./utils/sendEmail.js";

import User from "./models/user.model.js";
import Wallet from "./models/wallet.model.js";
import Position from "./models/position.model.js";

// ======================================================
// CONFIGURACIÓN SERVIDOR
// ======================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path:
    process.env.NODE_ENV === "production"
      ? undefined
      : path.resolve(__dirname, ".env"),
});

const app = express(); // <--- app debe declararse antes de usarlo
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
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS",
});

app.use("/api", limiter);
app.use("/api/password", passwordRoutes);
app.use("/api/withdraws", withdrawRoutes);

// ======================================================
// HELPERS AUTH
// ======================================================


// ======================================================
// DOCUMENT UPLOAD STORAGE
// ======================================================

const documentsDir = path.join(
  process.cwd(),
  "uploads",
  "documents"
);

if (!fs.existsSync(documentsDir)) {
  fs.mkdirSync(documentsDir, {
    recursive: true,
  });
}

const documentStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, documentsDir);
  },

  filename: (req, file, cb) => {
    const unique =
      Date.now() +
      "-" +
      Math.round(Math.random() * 1e9);

    cb(
      null,
      unique + path.extname(file.originalname)
    );
  },
});

const uploadDocument = multer({
  storage: documentStorage,

  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

// ======================================================
// DOCUMENTS (CLIENTE Y ADMIN)
// ======================================================

// Modelo Document
const documentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, default: "identity" },
  documentUrl: { type: String, required: true },
  status: { type: String, enum: ["pending","approved","rejected"], default: "pending" },
  adminNote: { type: String, default: "" },
}, { timestamps: true });

const Document = mongoose.models.Document || mongoose.model("Document", documentSchema);

// Rutas Document

// Admin
app.get("/api/admin/documents", requireAdmin, async (req, res) => {
  const docs = await Document.find().sort({ createdAt: -1 });
  res.json({ ok: true, count: docs.length, documents: docs });
});

// Cliente
app.get("/api/documents", async (req, res) => {
  const user = await safeGetUserFromBearer(req);
  if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const docs = await Document.find({ userId: user._id }).sort({ createdAt: -1 });
  res.json({ ok: true, count: docs.length, documents: docs });
});

// ======================================================
// SOCKET.IO & SERVER
// ======================================================

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

function compactSymbol(value = "") {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeSymbol(symbol = "") {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/^OANDA:/, "")
    .replace(/^TVC:/, "")
    .replace(/^FX:/, "")
    .replace(/^FOREX:/, "")
    .replace(/^C:/, "")
    .replace(/^X:/, "")
    .replace(/^I:/, "")
    .replace(/^INDEX:/, "")
    .replace(/^BINANCE:/, "")
    .replace(/^NASDAQ:/, "")
    .replace(/[\/:_\-]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function getMarketHint(symbol = "") {
  const clean = normalizeSymbol(symbol);
  if (!clean) return "";
  if (clean === "SPX" || clean.includes("SP500") || clean.includes("SNP")) return "index";
  if (/^[A-Z]{6}$/.test(clean)) return "forex";
  if (/^[A-Z]{3,5}USDT$/.test(clean) || /^[A-Z]{3,5}USD$/.test(clean)) return "crypto";
  if (/^[A-Z]{1,5}$/.test(clean)) return "stock";
  return "";
}

function toPolygonSymbol(value = "") {
  const clean = normalizeSymbol(value);
  if (!clean) return "";
  if (/^[A-Z]{6}$/.test(clean)) return `C:${clean}`;
  if (/^[A-Z]{3,5}USDT$/.test(clean)) return `X:${clean.slice(0, -4)}USD`;
  if (/^[A-Z]{3,5}USD$/.test(clean) && getMarketHint(clean) === "crypto") return `X:${clean.slice(0, -3)}USD`;
  if (clean === "SPX") return "I:SPX";
  return clean;
}

function buildSymbolAliases(symbol = "") {
  const raw = String(symbol || "").trim().toUpperCase();
  const noSpaces = raw.replace(/\s+/g, "");
  const noPrefix = noSpaces.includes(":") ? noSpaces.split(":").pop() : noSpaces;
  const compact = String(noPrefix).replace(/[^A-Z0-9]/g, "");
  const marketHint = getMarketHint(raw);

  const aliases = new Set([
    raw,
    noSpaces,
    noPrefix,
    compact,
    raw.replace(/^OANDA:/, ""),
    raw.replace(/^TVC:/, ""),
    raw.replace(/^C:/, ""),
    raw.replace(/^X:/, ""),
    raw.replace(/^FX:/, ""),
    raw.replace(/^BINANCE:/, ""),
    raw.replace(/^NASDAQ:/, ""),
    raw.replace(/^FOREX:/, ""),
    raw.replace(/^INDEX:/, ""),
    raw.replace(/^I:/, ""),
    raw.replace(/^B:{1}/, ""),
  ]);

  if (/^[A-Z]{6}$/.test(raw)) {
    const base = raw.slice(0, 3);
    const quote = raw.slice(3);
    aliases.add(`${base}_${quote}`);
    aliases.add(`${base}/${quote}`);
    aliases.add(`C:${raw}`);
    aliases.add(`FOREX:${raw}`);
    aliases.add(`FX:${raw}`);
    aliases.add(`TVC:${base}${quote}`);
  }

  if (/^[A-Z]{3,5}USDT$/.test(raw)) {
    const base = raw.slice(0, -4);
    aliases.add(`${base}USD`);
    aliases.add(`X:${base}USD`);
    aliases.add(`BINANCE:${base}USDT`);
    aliases.add(`BINANCE:${base}USD`);
  }

  if (/^[A-Z]{3,5}USD$/.test(raw) && marketHint === "crypto") {
    const base = raw.slice(0, -3);
    aliases.add(`${base}USDT`);
    aliases.add(`X:${base}USD`);
    aliases.add(`BINANCE:${base}USDT`);
  }

  if (raw === "SPX") {
    aliases.add("I:SPX");
    aliases.add("INDEX:SPX");
    aliases.add("^GSPC");
  }

  if (/^[A-Z]{1,5}$/.test(raw) && raw !== "SPX") {
    aliases.add(`NASDAQ:${raw}`);
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
    body.symbol || body.tvSymbol || body.selectedSymbol || body.chartSymbol || body.instrument || body.marketSymbol || body.market || body.ticker || body.asset || ""
  )
    .trim()
    .toUpperCase();
  return normalizeSymbol(raw);
}

function normalizeQty(body = {}) {
  const n = Number(body.qty ?? body.quantity ?? body.amount ?? body.positionSize ?? body.notional ?? body.size ?? body.volume ?? body.lots ?? body.contracts ?? body.units ?? body.lotSize);
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

function extractQuotePrice(item = {}, depth = 0) {
  if (!item || depth > 2) return null;

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
  const cleanSymbol = normalizeSymbol(symbol);
  const label = item.label || item.name || (cleanSymbol.split(":").pop() || cleanSymbol).replace("_", "/");
  return {
    symbol: cleanSymbol,
    label,
    market: item.market || "Unknown",
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
  { symbol: "BINANCE:BCHUSDT", label: "BCH/USDT", market: "Crypto" },
  { symbol: "BINANCE:ADAUSDT", label: "ADA/USDT", market: "Crypto" },
  { symbol: "FOREX:USDJPY", label: "USD/JPY", market: "Forex" },
];

async function buildQuotesArray() {
  const store = getPriceStore();

  const sampleQuotes = [];
  for (const sample of SAMPLE_SYMBOLS) {
    let found = findBestPriceMatch(sample.symbol, store);

    if (!found) {
      const live = getCurrentPriceForSymbol(sample.symbol);
      if (Number.isFinite(live) && live > 0) {
        found = { ...sample, price: live, updatedAt: new Date().toISOString() };
      }
    }

    if (!found || !Number.isFinite(extractQuotePrice(found)) || extractQuotePrice(found) <= 0) {
      try {
        const fallback = await fetchPolygonLastPrice(sample.symbol);
        if (fallback?.price && Number.isFinite(fallback.price) && fallback.price > 0) {
          found = {
            ...sample,
            symbol: sample.symbol,
            price: fallback.price,
            updatedAt: new Date().toISOString(),
            raw: fallback.raw,
          };
          safeStorePrice(sample.symbol, fallback.price, fallback.raw);
        }
      } catch {}
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

function getCurrentPriceForSymbol(symbol) {
  const targetCompact = compactSymbol(symbol);
  if (!targetCompact) return null;

  const store = getPriceStore();

  for (const [key, item] of Object.entries(store)) {
    const candidates = [key, item?.symbol, item?.label, item?.ticker, item?.tvSymbol, item?.instrument, item?.marketSymbol, item?.asset].filter(Boolean);
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

async function resolvePriceWithFallback(symbol, body = {}) {
  const direct = normalizePrice(body);
  if (direct) return direct;

  const current = getCurrentPriceForSymbol(symbol);
  if (Number.isFinite(current) && current > 0) return current;

  const store = getPriceStore();
  const found = findBestPriceMatch(symbol, store);
  const extracted = extractQuotePrice(found || {});
  if (Number.isFinite(extracted) && extracted > 0) return extracted;

  const fallback = await fetchPolygonLastPrice(symbol);
  if (fallback?.price && Number.isFinite(fallback.price) && fallback.price > 0) {
    safeStorePrice(symbol, fallback.price, fallback.raw);
    return fallback.price;
  }

  return null;
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
  const pnl = isClosedPosition(position) ? Number(position.realizedPnl ?? position.pnl ?? 0) || 0 : (currentPrice - entryPrice) * qty * sign;
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
    wallet = await Wallet.create({
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
  const normalizedWallet = normalizeWalletSnapshot(walletSnapshot ? { ...walletSnapshot, balanceOwn: balance, balance } : { balanceOwn: balance, balance }, openPnl);

  return {
    account: {
      ...normalizedWallet,
      name:
      userDoc.name ||
      userDoc.username ||
      userDoc.fullName ||
      "Cliente",

    username:
      userDoc.username ||
      userDoc.name ||
      "Cliente",

    email: userDoc.email || "",

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
  const walletSnapshot = normalizeWalletSnapshot({
    balanceOwn: 0,
    balance: 0,
    credit: 0,
    marginUsed: 0,
    leverageFactor: Number(userDoc?.leverage ?? 1) || 1,
    equity: 0,
    freeMargin: 0,
    marginLevel: 0,
    currency: userDoc?.currency || "USD",
  }, 0);

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
  const timer = setTimeout(async () => { liveSyncTimers.delete(key); try { await syncLivePnLForSymbol(symbol); } catch (e) { console.warn("syncLivePnL error:", e?.message || e); } }, 120);
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
      await Position.updateOne({ _id: pos._id }, { $set: { currentPrice, pnl: livePnl, unrealizedPnl: livePnl, updatedAt: updateTime } }).catch(() => null);
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


/* ======================================================
   TRANSACTIONS API
   ====================================================== */
app.get("/api/transactions/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        ok: false,
        message: "userId requerido"
      });
    }

    const transactions = await Transaction.find({ user: userId })
      .sort({ createdAt: -1 });

    return res.json(transactions);

  } catch (err) {
    console.error("❌ ERROR transactions:", err);
    return res.status(500).json({
      ok: false,
      message: "Error interno del servidor"
    });
  }
});

// ======================================================
// RETIRO CLIENTE
// ======================================================
app.post("/api/withdraw/request", async (req, res) => {
  try {
    const user = await safeGetUserFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const { amount, note } = req.body || {};
    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ ok: false, error: "amount_required" });
    }

    const wallet = await getWalletDocForUser(user._id);
    const balance = Number(wallet.balanceOwn ?? wallet.balance ?? 0);

    if (numericAmount > balance) {
      return res.status(400).json({ ok: false, error: "insufficient_balance" });
    }

    // Guardar el retiro en la colección Withdraw
    const withdraw = await Withdraw.create({
      user: user._id,
      amount: numericAmount,
      status: "pending",
      note: note || "",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Opcional: emitir evento a admin vía socket
    io.emit("withdraw:new", { withdraw });

    return res.json({ ok: true, msg: "Solicitud de retiro creada", withdraw });
  } catch (err) {
    console.error("/api/withdraw/request error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  }
});

// ======================================================
// DOCUMENTOS CLIENTE
// ======================================================
app.post("/api/documents/upload", async (req, res) => {
  try {
    const user = await safeGetUserFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const { type, documentUrl } = req.body || {};

    if (!documentUrl || typeof documentUrl !== "string") {
      return res.status(400).json({ ok: false, error: "documentUrl_required" });
    }

    const doc = await Document.create({
      userId: user._id,
      type: type || "identity",
      documentUrl,
      status: "pending",
      adminNote: "",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Opcional: notificar admin
    io.emit("document:new", { document: doc });

    return res.json({ ok: true, msg: "Documento subido", document: doc });
  } catch (err) {
    console.error("/api/documents/upload error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  }
});


// ======================================================
// SUBIR DOCUMENTO
// ======================================================

app.post(
  "/api/documents",
  uploadDocument.single("document"),
  async (req, res) => {
    try {
      const user = await safeGetUserFromBearer(req);

      if (!user) {
        return res.status(401).json({
          ok: false,
          error: "Unauthorized",
        });
      }

      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error: "Documento requerido",
        });
      }

      const document = await Document.create({
        userId: user._id,

        type:
          req.body.type || "identity",

        documentUrl:
          "/uploads/documents/" +
          req.file.filename,

        status: "pending",
      });

      res.json({
        ok: true,
        document,
      });
    } catch (err) {
      console.error(
        "DOCUMENT UPLOAD ERROR:",
        err
      );

      res.status(500).json({
        ok: false,
        error: err.message,
      });
    }
  }
);
        
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

app.get("/api/markets", (req, res) => res.json({ markets: ["Crypto", "Stocks", "Forex", "Indices", "Futures", "Bonds"] }));
app.get("/api/market/list", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/market/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/markets/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/api/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/api/markets", (req, res) => res.json({ markets: ["Crypto", "Stocks", "Forex", "Indices"] }));

try {
  if (typeof marketRoutesFactory === "function") {
    app.use("/api/market", marketRoutesFactory({ polygonSocket: null, priceHandler }));
  } else {
    app.use("/api/market", marketRoutesFactory);
  }
} catch (e) {
  console.warn("No se pudo montar /api/market:", e && e.message ? e.message : e);
}

app.get("/api/quotes", async (req, res) => res.json((await buildMarketPayload()).quotes));

app.get("/api/quotes", (req, res) => {
  const data = priceHandler.getAllPrices();

  const symbols = [
    "BTCUSDT",
    "ETHUSDT",
    "EURUSD",
    "AAPL",
    "SPX",
    "BCHUSDT",
    "ADAUSDT",
    "USDJPY"
  ];

  const response = symbols.map((sym) => {
    const clean = sym.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const p = data[clean] || {};

    return {
      symbol: sym,
      price: p.price ?? 0,
      change: p.change ?? 0,
      updatedAt: p.updatedAt || p.ts || null
    };
  });

  res.json(response);
});

/* ======================================================
   FIX /api/latest
   ====================================================== */

app.get("/api/latest", async (req, res) => {
  try {
    const rawSymbol = req.query.symbol || req.query.tvSymbol || req.query.selectedSymbol || "";
    const symbol = normalizeSymbol(String(rawSymbol || "").trim().toUpperCase());

    if (!symbol) {
      return res.json({ ok: true, symbol: null, price: null, currentPrice: null, close: null, last: null, updatedAt: new Date().toISOString(), message: "symbol_missing" });
    }

    let price = getCurrentPriceForSymbol(symbol);
    if (!Number.isFinite(price) || price <= 0) {
      const store = getPriceStore?.() || {};
      const found = findBestPriceMatch(symbol, store);
      if (found) price = extractQuotePrice(found);
    }

    if (!Number.isFinite(price) || price <= 0) {
      const fallback = await fetchPolygonLastPrice(symbol);
      if (fallback?.price && Number.isFinite(fallback.price) && fallback.price > 0) {
        price = fallback.price;
        safeStorePrice(symbol, price, fallback.raw);
      }
    }

    if (!Number.isFinite(price) || price <= 0) {
      return res.json({ ok: false, error: "price_not_found", symbol, price: null, currentPrice: null, close: null, last: null, updatedAt: new Date().toISOString() });
    }

    return res.json({ ok: true, symbol, price, currentPrice: price, close: price, last: price, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error("/api/latest error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/market/quotes", async (req, res) => res.json(await buildMarketPayload()));
app.get("/api/market/latest", async (req, res) => {
  try {
    const rawSymbol = req.query.symbol || req.query.tvSymbol || req.query.selectedSymbol || "";
    const symbol = normalizeSymbol(String(rawSymbol || "").trim().toUpperCase());

    if (!symbol) {
      return res.json({ ok: true, symbol: null, price: null, currentPrice: null, close: null, last: null, updatedAt: new Date().toISOString(), message: "symbol_missing" });
    }

    let price = getCurrentPriceForSymbol(symbol);
    if (!Number.isFinite(price) || price <= 0) {
      const store = getPriceStore?.() || {};
      const found = findBestPriceMatch(symbol, store);
      if (found) price = extractQuotePrice(found);
    }

    if (!Number.isFinite(price) || price <= 0) {
      const fallback = await fetchPolygonLastPrice(symbol);
      if (fallback?.price && Number.isFinite(fallback.price) && fallback.price > 0) {
        price = fallback.price;
        safeStorePrice(symbol, price, fallback.raw);
      }
    }

    if (!Number.isFinite(price) || price <= 0) {
      return res.json({ ok: false, error: "price_not_found", symbol, price: null, currentPrice: null, close: null, last: null, updatedAt: new Date().toISOString() });
    }

    return res.json({ ok: true, symbol, price, currentPrice: price, close: price, last: price, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error("/api/market/latest error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/market/polygon/quotes", async (req, res) => res.json(await buildMarketPayload()));
app.get("/api/market/polygon/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));

app.get("/api/symbols", (req, res) => {
  try {
    const prices = getPriceStore();
    if (prices && Object.keys(prices).length) {
      return res.json(Object.keys(prices).map((k) => ({ symbol: k, label: (k.split(":").pop() || k).replace("_", "/"), market: prices[k]?.market || "Unknown" })));
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
    return res.json({ ok: true, wallet: payload.wallet, account: payload.account, balance: payload.account.balance, balanceOwn: payload.account.balanceOwn, availableBalance: payload.account.availableBalance, equity: payload.account.equity, marginUsed: payload.account.marginUsed, freeMargin: payload.account.freeMargin, marginLevel: payload.account.marginLevel, leverageFactor: payload.account.leverageFactor, currency: payload.account.currency, transactions: payload.transactions });
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
    const currency = String(body.currency || "USD").trim();

    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: "amount_required" });

    const user = await User.findById(userId).catch(() => null);
    if (!user) return res.status(404).json({ ok: false, error: "user_not_found" });

    const wallet = await getWalletDocForUser(user._id);
    const balanceBefore = Number(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) || 0;

    wallet.balanceOwn = balanceBefore + amount;
    wallet.balance = wallet.balanceOwn;
    wallet.currency = currency || wallet.currency || "USD";

    if (Number.isFinite(leverage) && leverage > 0) {
      wallet.leverageFactor = leverage;
      user.leverage = leverage;
    }

    wallet.equity = wallet.balanceOwn + Number(wallet.marginUsed ?? 0) + Number(wallet.credit ?? 0);
    wallet.marginUsed = Number(wallet.marginUsed ?? 0) || 0;
    wallet.freeMargin = Math.max(wallet.balanceOwn + Number(wallet.credit ?? 0), 0);
    wallet.updatedAt = new Date();
    await wallet.save();

    user.balance = wallet.balanceOwn;
    user.currency = currency || user.currency || "USD";
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

    return res.json({ ok: true, msg: "Depósito aplicado", data: { balance: wallet.balanceOwn, leverage: wallet.leverageFactor, transaction: tx, account: account.account, wallet: account.wallet } });
  } catch (err) {
    console.error("/api/admin/deposit error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  }
});

        // ======================================================
// CLIENT WITHDRAW REQUEST
// ======================================================

app.post("/api/withdraw/request", async (req, res) => {
  try {

    const user = await getUserDocFromBearer(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    const body = req.body || {};

    const amount = Number(body.amount || 0);

    const method =
      String(body.method || body.withdrawMethod || "USDT").trim();

    const walletAddress =
      String(body.walletAddress || body.address || "").trim();

    const note =
      String(body.note || "").trim();

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        ok: false,
        error: "invalid_amount"
      });
    }

    if (!walletAddress) {
      return res.status(400).json({
        ok: false,
        error: "wallet_required"
      });
    }

    const wallet = await getWalletDocForUser(user._id);

    const balance =
      Number(wallet.balanceOwn ?? wallet.balance ?? 0);

    if (amount > balance) {
      return res.status(400).json({
        ok: false,
        error: "insufficient_balance"
      });
    }

    // 🔥 GUARDAR EN MONGODB
    const withdraw = await Withdraw.create({
      user: user._id,
      amount,
      method,
      walletAddress,
      note,
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log("✅ WITHDRAW CREATED:", withdraw._id);

    io.emit("withdraw:new", withdraw);

    return res.json({
      ok: true,
      message: "Retiro enviado",
      withdraw
    });

  } catch (err) {

    console.error("❌ /api/withdraw/request:", err);

    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message || "Error interno"
    });
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
    wallet.equity = wallet.balanceOwn + Number(wallet.marginUsed ?? 0) + Number(wallet.credit ?? 0);
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

    return res.json({ ok: true, msg: "Retiro aplicado", data: { balance: wallet.balanceOwn, transaction: tx, account: account.account, wallet: account.wallet } });
  } catch (err) {
    console.error("/api/admin/withdraw error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  }
});

app.get("/api/admin/transactions", requireAdmin, async (req, res) => {
  try {
    const userId = req.query.userId || null;
    const limit = Math.min(Number(req.query.limit || 100) || 100, 500);
    const txs = userId ? await safeLoadTransactionsForUser(userId, limit) : await Transaction.find({}).sort({ createdAt: -1 }).limit(limit).lean().exec().catch(() => []);
    return res.json({ ok: true, count: txs.length, transactions: txs, data: txs, items: txs });
  } catch (err) {
    console.error("/api/admin/transactions error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  }
});

app.post("/api/trade/open", async (req, res) => {
  let lockKey = null;

  try {
    const user = await getUserDocFromBearer(req);
    if (!user) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const body = req.body || {};
    const symbol = String(body.symbol || "").trim().toUpperCase();

    if (!symbol) {
      return res.status(400).json({
        ok: false,
        error: "symbol_required",
        message: "El símbolo no llegó desde el frontend",
      });
    }

    const side = normalizeSide(body.side);
    if (!side) {
      return res.status(400).json({ ok: false, error: "invalid_side" });
    }

    const wallet = await getWalletDocForUser(user._id);

    // =========================
    // 🔥 SALDO REAL (SIN INVENTAR)
    // =========================
    const balanceOwn =
      Number(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) || 0;

    const credit = Number(wallet.credit ?? 0) || 0;
    const marginUsed = Number(wallet.marginUsed ?? 0) || 0;

    const leverageRaw = Number(wallet.leverageFactor ?? user.leverage);
    const leverage =
      Number.isFinite(leverageRaw) && leverageRaw > 0 ? leverageRaw : 10;

    // =========================
    // PRICE
    // =========================
    let price =
      Number(body.price) ||
      Number(body.entryPrice) ||
      getSimulatedPrice(symbol);

    if (!Number.isFinite(price) || price <= 0) {
      price = getSimulatedPrice(symbol);
    }

    // =========================
    // 🔥 SALDO REAL DISPONIBLE
    // =========================
    const equity = balanceOwn + credit;
    const freeMargin = equity - marginUsed;

    if (freeMargin <= 0) {
      return res.status(400).json({
        ok: false,
        error: "no_margin",
        message: "No tienes margen disponible",
      });
    }

    const buyingPower = freeMargin * leverage;

    // =========================
    // 🔥 QTY DEL USUARIO (NO SE TOCA)
    // =========================
    const qty = normalizeQty(body);

    if (!qty || qty <= 0) {
      return res.status(400).json({
        ok: false,
        error: "invalid_qty",
      });
    }

    // =========================
    // 🔥 VALIDACIÓN REAL (CLAVE)
    // =========================
    const notional = qty * price;
    const requiredMargin = notional / leverage;

    // ❌ SI EXCEDE SALDO O APALANCAMIENTO → NO ABRE
    if (notional > buyingPower || requiredMargin > freeMargin) {
      return res.status(400).json({
        ok: false,
        error: "insufficient_funds",
        message: "No tienes saldo o margen suficiente para esta operación",
        balance: equity,
        freeMargin,
        buyingPower,
        requiredMargin,
        notional,
      });
    }

    // =========================
    // 🧾 UPDATE WALLET (SOLO MARGEN)
    // =========================
    wallet.marginUsed = marginUsed + requiredMargin;

    wallet.equity = equity;
    wallet.freeMargin = Math.max(equity - wallet.marginUsed, 0);

    await wallet.save();

    // =========================
    // POSITION (SIN AUTO CAMBIAR QTY)
    // =========================
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
    const annotatedPosition = annotatePosition(position.toObject());

    emitStateUpdates(user._id, account, [annotatedPosition], null);
    scheduleLivePnLSync(symbol);

    return res.json({
      ok: true,
      msg: "OPENED",
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
      releaseOpenLock(lockKey);
      releaseActiveOrder(lockKey);
    }
  }
});
/* ======================================================
   ROUTES MODULARES
   ====================================================== */
/* ======================================================
   PRECIO SIMULADO INTERNO
   ====================================================== */

const simulatedPrices = new Map();

function generateBasePrice(symbol = "") {
  const s = String(symbol).toUpperCase();

  // precios base por tipo
  if (s.includes("BTC")) return 65000 + Math.random() * 5000;
  if (s.includes("ETH")) return 3000 + Math.random() * 300;
  if (s.includes("XAU")) return 2300 + Math.random() * 50;
  if (s.includes("NVDA")) return 900 + Math.random() * 100;
  if (s.includes("AAPL")) return 180 + Math.random() * 20;
  if (s.includes("TSLA")) return 200 + Math.random() * 50;

  // cualquier símbolo desconocido
  return 50 + Math.random() * 500;
}

function getSimulatedPrice(symbol) {
  symbol = String(symbol || "").toUpperCase().trim();

  if (!simulatedPrices.has(symbol)) {
    simulatedPrices.set(symbol, generateBasePrice(symbol));
  }

  let current = simulatedPrices.get(symbol);

  // movimiento aleatorio natural
  const movement = (Math.random() - 0.5) * (current * 0.01);

  current += movement;

  // nunca permitir <= 0
  if (current <= 0) {
    current = generateBasePrice(symbol);
  }

  simulatedPrices.set(symbol, current);

  return Number(current.toFixed(2));
}

/* ======================================================
   API PRICE
   ====================================================== */

app.get("/api/price", async (req, res) => {
  try {
    let symbol = String(req.query.symbol || "UNKNOWN")
      .trim()
      .toUpperCase();

    const price = getSimulatedPrice(symbol);

    return res.json({
      ok: true,
      simulated: true,
      symbol,
      price
    });

  } catch (err) {
    console.error("❌ PRICE ERROR:", err);

    // fallback ABSOLUTO
    return res.json({
      ok: true,
      simulated: true,
      symbol: "FALLBACK",
      price: 100
    });
  }
});

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
   API PRICE
   ====================================================== */



/* ======================================================
   SOCKET.IO
   ====================================================== */

let polygonSocket = null;

function extractSymbol(data) {
  return normalizeSymbol(data?.symbol || data?.ticker || data?.sym || data?.T || data?.s || data?.instrument || data?.marketSymbol || data?.asset || data?.name || data?.label || "");
}

function extractPrice(data = {}) {
  return extractQuotePrice(data);
}

function safeStorePrice(symbol, price, rawData = null) {
  const clean = normalizeSymbol(symbol);
  const numeric = Number(price);
  if (!clean || !Number.isFinite(numeric) || numeric <= 0) {
    console.warn("❌ NO SE GUARDA PRECIO INVÁLIDO:", symbol, price);
    return false;
  }

  const payload = {
    symbol: clean,
    price: numeric,
    updatedAt: new Date().toISOString(),
    raw: rawData || null,
  };

  if (priceHandler?.prices instanceof Map) {
    priceHandler.prices.set(clean, payload);
  } else if (typeof priceHandler?.prices === "object") {
    priceHandler.prices[clean] = payload;
  }

  if (typeof updatePriceStore === "function") {
    try { updatePriceStore(clean, numeric); } catch (err) { console.warn("updatePriceStore error:", err?.message || err); }
  }

  console.log("📥 PRICE UPDATE:", clean, numeric);
  return true;
}

async function fetchPolygonLastPrice(symbol) {
  try {
    const clean = normalizeSymbol(symbol);
    if (!clean || !process.env.POLYGON_API_KEY) return null;
    const polygonSymbol = toPolygonSymbol(clean);
    if (!polygonSymbol) {
      console.warn("❌ INVALID POLYGON SYMBOL:", clean);
      return null;
    }

    const url = `https://api.polygon.io/v2/last/trade/${encodeURIComponent(polygonSymbol)}?apiKey=${encodeURIComponent(process.env.POLYGON_API_KEY)}`;
    console.log("🌍 FETCH FALLBACK:", polygonSymbol);

    try {
      const response = await fetch(url);
      const data = await response.json();
      console.log("🌍 FALLBACK RESPONSE:", JSON.stringify(data, null, 2));
      const price = extractQuotePrice(data);
      if (price && Number.isFinite(price) && price > 0) {
        return { price, raw: data, symbol: clean, polygonSymbol };
      }
    } catch (e) {
      console.warn("⚠️ Polygon fallback attempt failed:", e?.message || e);
    }

    console.warn("❌ FALLBACK PRICE INVALID:", clean);
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
      console.log("🔥 AUTO SUBSCRIBED:", sym);
    } catch (subErr) {
      console.warn("❌ AUTO SUBSCRIBE ERROR:", sym, subErr?.message || subErr);
    }
  }
}

io.on("connection", (socket) => {
  console.log("📡 Cliente conectado:", socket.id);

  try { socket.emit("prices_snapshot", getPriceStore() || {}); } catch { socket.emit("prices_snapshot", {}); }

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
    try { socket.emit("prices_snapshot", getPriceStore() || {}); } catch { socket.emit("prices_snapshot", {}); }
  });

  socket.on("request_symbols", () => {
    try {
      const prices = getPriceStore();
      if (priceHandler && typeof priceHandler.getSymbols === "function") {
        socket.emit("symbols_update", priceHandler.getSymbols() || []);
      } else if (prices && Object.keys(prices).length) {
        socket.emit("symbols_update", Object.keys(prices).map((k) => ({ symbol: k, label: (k.split(":").pop() || k).replace("_", "/"), market: prices[k]?.market || "Unknown" })));
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
      console.log("📡 SUBSCRIBE REQUEST:");
      console.log("RAW:", symbol);
      console.log("CLEAN:", cleanSymbol);
      console.log("POLYGON:", polygonSymbol);
      console.log("KIND:", kind || "trades");
      if (polygonSocket?.subscribe && polygonSymbol) {
        polygonSocket.subscribe(polygonSymbol, kind || "trades");
        console.log("✅ POLYGON SUBSCRIBED:", polygonSymbol);
      } else {
        console.warn("❌ polygonSocket.subscribe unavailable");
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
        console.log("❌ POLYGON UNSUBSCRIBED:", polygonSymbol);
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
          console.log("📊 PRICE RAW:", JSON.stringify(data, null, 2));
          const symbol = extractSymbol(data);
          let finalPrice = extractPrice(data);
          console.log("🔥 EXTRACTED PRICE:", finalPrice);
          if (!symbol) {
            console.warn("❌ SYMBOL INVALID:", data);
            return;
          }
          if (!finalPrice || !Number.isFinite(finalPrice) || finalPrice <= 0) {
            try {
              console.warn("⚠️ SOCKET PRICE INVALID -> FETCH FALLBACK:", symbol);
              const fallback = await fetchPolygonLastPrice(symbol);
              finalPrice = fallback?.price || null;
              if (finalPrice && Number.isFinite(finalPrice) && finalPrice > 0) {
                safeStorePrice(symbol, finalPrice, fallback.raw);
                console.log("✅ STORE UPDATED FALLBACK:", symbol, finalPrice);
              }
            } catch (fallbackErr) {
              console.warn("❌ FALLBACK FETCH ERROR:", fallbackErr?.message || fallbackErr);
            }
          }
          if (!finalPrice || !Number.isFinite(finalPrice) || finalPrice <= 0) {
            console.warn("❌ FINAL PRICE INVALID:", symbol, finalPrice);
            return;
          }
          safeStorePrice(symbol, Number(finalPrice), data);
          console.log("✅ STORE UPDATED:", symbol, finalPrice);
          if (priceHandler?.handle) {
            try { priceHandler.handle({ ...data, symbol, price: Number(finalPrice) }); } catch (handlerErr) { console.warn("priceHandler.handle error:", handlerErr?.message || handlerErr); }
          }
          if (typeof updatePriceStore === "function") {
            try { updatePriceStore(symbol, Number(finalPrice)); } catch (storeErr) { console.warn("updatePriceStore error:", storeErr?.message || storeErr); }
          }
          scheduleLivePnLSync(symbol);
        } catch (err) {
          console.warn("onPrice handler error:", err?.message || err);
        }
      },
      onOpen: async () => {
        console.log("✅ PolygonSocket abierto");
        try { await safeAutoSubscribeDefaults(); } catch (err) { console.warn("❌ AUTO SUBSCRIBE FAILED:", err?.message || err); }
      },
      onClose: () => { console.log("❌ PolygonSocket cerrado"); },
      onError: (err) => { console.error("❌ PolygonSocket error:", err?.message || err); },
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
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) { staticDirName = cand; break; }
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
  return uniqueCandidates.find((p) => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } });
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

/* ======================================================
   GET REAL PRICE (FIX REAL)
   ====================================================== */

 app.get("/api/price", async (req, res) => {
  try {
    const rawSymbol = String(
      req.query.symbol || req.query.tvSymbol || req.query.selectedSymbol || ""
    );
    const symbol = normalizeSymbol(rawSymbol);

    if (!symbol) {
      return res.status(400).json({ ok: false, error: "Símbolo requerido" });
    }

    // 🔥 AUTO-SEED TOTAL
    forcePriceExists(symbol);

    let found = null;

    try {
      if (priceHandler?.prices) {
        const store =
          priceHandler.prices instanceof Map
            ? Object.fromEntries(priceHandler.prices.entries())
            : priceHandler.prices;

        found = findBestPriceMatch(symbol, store || {});
      }

      if (!found) {
        found = findBestPriceMatch(symbol, getPriceStore?.() || {});
      }
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

    // 🔥 FIX 1: usar motor fake local si no hay precio
    if (!price || !Number.isFinite(price) || price <= 0) {
      price = global.getFakePrice?.(symbol);
      if (price && Number.isFinite(price) && price > 0) {
        safeStorePrice(symbol, price, found?.raw || null);
      }
    }

    // 🔥 FIX 2: mantener respaldo externo si existe
    if (!price || !Number.isFinite(price) || price <= 0) {
      try {
        const fallback = await fetchPolygonLastPrice(symbol);
        const fallbackPrice = Number(fallback?.price);

        if (Number.isFinite(fallbackPrice) && fallbackPrice > 0) {
          price = fallbackPrice;
          safeStorePrice(symbol, fallbackPrice, fallback?.raw || null);
        }
      } catch (err) {
        console.warn("❌ FALLBACK ERROR:", err?.message || err);
      }
    }

    // 🔥 FIX 3: garantía final absoluta
    if (!price || !Number.isFinite(price) || price <= 0) {
      price = forcePriceExists(symbol) || global.getFakePrice?.(symbol);

      if (!price || !Number.isFinite(price) || price <= 0) {
        price = 50 + Math.random() * 1000;
      }

      safeStorePrice(symbol, price, found?.raw || null);
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
    return res.status(500).json({ ok: false, error: "Error interno" });
  }
});

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
process.on("unhandledRejection", (r) => { console.error("UnhandledRejection:", r); gracefulShutdown("unhandledRejection").catch(() => {}); });
process.on("uncaughtException", (e) => { console.error("UncaughtException:", e); gracefulShutdown("uncaughtException").catch(() => {}); });

export default app;
