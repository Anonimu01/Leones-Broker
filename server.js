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
    startRiskWatcher({ intervalMs, alertThreshold, closeThreshold });
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
   HELPERS
   ====================================================== */

const openTradeLocks = new Map();
const recentOpenFingerprints = new Map();
const OPEN_LOCK_TTL_MS = Number(process.env.OPEN_LOCK_TTL_MS) || 1800;
const OPEN_FINGERPRINT_TTL_MS = Number(process.env.OPEN_FINGERPRINT_TTL_MS) || 2500;
const MAX_QUOTE_AGE_MS = Number(process.env.MAX_QUOTE_AGE_MS) || 10000;

function makeOpenLockKey(userId, symbol, side) {
  return `${String(userId || "")}:${String(symbol || "")}:${String(side || "")}`;
}

function makeOrderFingerprint({ userId, symbol, side, qty, price }) {
  return `${String(userId || "")}:${String(symbol || "")}:${String(side || "")}:${String(qty || "")}:${String(price || "")}`;
}

function withOpenLock(key, ttlMs = OPEN_LOCK_TTL_MS) {
  const now = Date.now();
  const until = openTradeLocks.get(key) || 0;
  if (until > now) return false;

  openTradeLocks.set(key, now + ttlMs);

  const timer = setTimeout(() => {
    const current = openTradeLocks.get(key) || 0;
    if (current <= Date.now()) openTradeLocks.delete(key);
  }, ttlMs + 100);

  if (timer && typeof timer.unref === "function") timer.unref();
  return true;
}

function releaseOpenLock(key) {
  openTradeLocks.delete(key);
}

function rememberFingerprint(key, ttlMs = OPEN_FINGERPRINT_TTL_MS) {
  recentOpenFingerprints.set(key, Date.now() + ttlMs);

  const timer = setTimeout(() => {
    const current = recentOpenFingerprints.get(key) || 0;
    if (current <= Date.now()) recentOpenFingerprints.delete(key);
  }, ttlMs + 100);

  if (timer && typeof timer.unref === "function") timer.unref();
}

function isFingerprintBlocked(key) {
  const until = recentOpenFingerprints.get(key) || 0;
  return until > Date.now();
}

function compactSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function symbolVariants(value) {
  const raw = String(value || "").trim().toUpperCase();
  const afterColon = raw.includes(":") ? raw.split(":").pop() : raw;
  const afterSlash = afterColon.includes("/") ? afterColon.split("/").join("") : afterColon;
  const afterDash = afterSlash.includes("-") ? afterSlash.split("-").join("") : afterSlash;

  return [...new Set([
    compactSymbol(raw),
    compactSymbol(afterColon),
    compactSymbol(afterSlash),
    compactSymbol(afterDash),
  ].filter(Boolean))];
}

function normalizeSide(value) {
  const s = String(value || "").trim().toUpperCase();
  if (["BUY", "LONG", "BULL", "CALL"].includes(s)) return "BUY";
  if (["SELL", "SHORT", "BEAR", "PUT"].includes(s)) return "SELL";
  return "";
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

function normalizePositionSymbol(body = {}) {
  return String(
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

function normalizeQuote(symbol, item = {}) {
  const label =
    item.label ||
    item.name ||
    (symbol.split(":").pop() || symbol).replace("_", "/");

  return {
    symbol,
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

function buildQuotesArray() {
  const store = getPriceStore();
  const keys = Object.keys(store);
  if (keys.length) return keys.map((symbol) => normalizeQuote(symbol, store[symbol] || {}));
  return SAMPLE_SYMBOLS.map((s) =>
    normalizeQuote(s.symbol, {
      label: s.label,
      market: s.market,
      price: null,
      updatedAt: new Date().toISOString(),
    })
  );
}

function buildMarketPayload() {
  const quotes = buildQuotesArray();
  return { ok: true, count: quotes.length, quotes, data: quotes, items: quotes, latest: quotes[0] || null };
}

function getMatchedQuote(symbol) {
  const targetVariants = symbolVariants(symbol);
  if (!targetVariants.length) return null;

  const store = getPriceStore();
  for (const [key, item] of Object.entries(store)) {
    const keyVariants = symbolVariants(key);
    const itemVariants = symbolVariants(item?.symbol || "");
    const labelVariants = symbolVariants(item?.label || "");
    const matched = [...keyVariants, ...itemVariants, ...labelVariants].some((v) => targetVariants.includes(v));
    if (!matched) continue;

    const px = extractQuotePrice(item);
    const updatedAt = item?.updatedAt || item?.timestamp || null;
    const ts = updatedAt ? new Date(updatedAt).getTime() : NaN;
    if (!(Number.isFinite(px) && px > 0)) continue;
    if (!Number.isFinite(ts)) continue;

    return {
      symbol,
      price: px,
      updatedAt: new Date(ts).toISOString(),
      source: key,
      raw: item,
    };
  }
  return null;
}

function getValidatedMarketPrice(symbol) {
  const quote = getMatchedQuote(symbol);
  if (!quote) return null;

  const age = Date.now() - new Date(quote.updatedAt).getTime();
  if (!Number.isFinite(age) || age < 0 || age > MAX_QUOTE_AGE_MS) return null;

  return quote;
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
  const currentPrice = Number(position.currentPrice ?? getMatchedQuote(position.symbol)?.price ?? entryPrice) || entryPrice;
  const qty = Number(position.qty ?? position.quantity ?? position.amount ?? position.positionSize ?? 0) || 0;
  const pnl = isClosedPosition(position)
    ? Number(position.realizedPnl ?? position.pnl ?? 0) || 0
    : computePositionPnl({ ...position, entryPrice, qty }, currentPrice);

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
  const equity = balanceOwn + openPnl;
  const freeMargin = Math.max(equity + credit - marginUsed, 0);
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
    openPnl,
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
  const rows = await Position.find({ user: userId, status: { $in: ["OPEN", "open", "Open"] } })
    .sort({ createdAt: -1 })
    .lean()
    .exec()
    .catch(() => []);
  return (rows || []).map(annotatePosition);
}

async function loadAllPositionsForUser(userId) {
  const rows = await Position.find({ user: userId })
    .sort({ createdAt: -1 })
    .lean()
    .exec()
    .catch(() => []);
  return (rows || []).map(annotatePosition);
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
      equity: balance + openPnl,
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
    io.emit("wallet_update", { userId, account: accountPayload?.account || accountPayload });
    io.emit("account_update", { userId, account: accountPayload?.account || accountPayload });
    if (Array.isArray(positions)) io.emit("positions_update", { userId, positions });
    if (transaction) io.emit("transactions_update", { userId, transaction });
  } catch (e) {
    console.warn("emitStateUpdates error:", e?.message || e);
  }
}

async function applyCloseToPosition({ user, positionDoc, currentPrice, source = "api/trade/close" }) {
  const position = positionDoc?.toObject ? positionDoc.toObject() : positionDoc;
  const symbol = String(position.symbol || "").toUpperCase();
  const side = normalizeSide(position.side || position.direction);
  const entryPrice = Number(position.entryPrice ?? position.price ?? position.openPrice ?? 0) || 0;
  const qty = Number(position.qty ?? position.quantity ?? position.amount ?? 0) || 0;
  const sign = side === "SELL" ? -1 : 1;
  const realizedPnl = (Number(currentPrice) - entryPrice) * qty * sign;

  const wallet = await getWalletDocForUser(user._id);
  const balanceBefore = Number(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) || 0;
  const reservedMargin = Number(position.marginReserved ?? 0) || 0;
  const marginUsedBefore = Number(wallet.marginUsed ?? 0) || 0;

  wallet.marginUsed = Math.max(marginUsedBefore - reservedMargin, 0);
  wallet.balanceOwn = balanceBefore + reservedMargin + realizedPnl;
  wallet.balance = wallet.balanceOwn;
  wallet.equity = wallet.balanceOwn;
  wallet.freeMargin = Math.max(wallet.equity + (Number(wallet.credit ?? 0) || 0) - wallet.marginUsed, 0);
  wallet.marginLevel = wallet.marginUsed > 0 ? (wallet.equity / wallet.marginUsed) * 100 : 0;
  wallet.updatedAt = new Date();
  await wallet.save();

  user.balance = wallet.balanceOwn;
  await user.save();

  position.status = "CLOSED";
  position.currentPrice = currentPrice;
  position.closePrice = currentPrice;
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
      closePrice: currentPrice,
      marginReleased: reservedMargin,
      realizedPnl,
    },
    source,
  });

  const account = await buildAccountForUser(user);
  const annotatedPosition = annotatePosition(position);
  emitStateUpdates(user._id, account, [annotatedPosition], tx);

  return {
    positionId: position._id,
    symbol,
    side,
    qty,
    entryPrice,
    currentPrice,
    realizedPnl,
    balance: wallet.balanceOwn,
    account: account.account,
    wallet: account.wallet,
    position: annotatedPosition,
    transaction: tx,
  };
}

/* ======================================================
   TRADING CORE
   ====================================================== */

app.post("/api/trade/open", async (req, res) => {
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const body = req.body || {};
    const symbol = normalizePositionSymbol(body);
    const side = normalizeSide(body.side);
    const qty = normalizeQty(body);
    const clientOrderId = String(body.clientOrderId || body.orderId || body.id || "").trim();

    if (!symbol || !side || !qty) {
      return res.status(400).json({ ok: false, error: "invalid_params" });
    }

    const lockKey = clientOrderId
      ? `cid:${user._id}:${clientOrderId}`
      : makeOpenLockKey(user._id, symbol, side);

    if (!withOpenLock(lockKey)) {
      return res.status(429).json({ ok: false, error: "duplicate_order_blocked" });
    }

    try {
      const fp = makeOrderFingerprint({ userId: user._id, symbol, side, qty, price: body.price || body.currentPrice || "" });
      if (isFingerprintBlocked(fp)) {
        return res.status(429).json({ ok: false, error: "duplicate_order_blocked" });
      }
      rememberFingerprint(fp);
    } catch {}

    const quote = getValidatedMarketPrice(symbol);
    if (!quote) {
      releaseOpenLock(lockKey);
      return res.status(400).json({ ok: false, error: "price_invalid_or_stale" });
    }

    const price = Number(quote.price);
    if (!Number.isFinite(price) || price <= 0) {
      releaseOpenLock(lockKey);
      return res.status(400).json({ ok: false, error: "price_invalid" });
    }

    const wallet = await getWalletDocForUser(user._id);
    const balanceOwn = Number(wallet.balanceOwn || 0);
    const credit = Number(wallet.credit || 0);
    const marginUsed = Number(wallet.marginUsed || 0);
    const leverage = Math.max(Number(wallet.leverageFactor || 1), 1);

    const notional = qty * price;
    const requiredMargin = notional / leverage;

    const freeMargin = balanceOwn + credit - marginUsed;

    if (!Number.isFinite(requiredMargin) || requiredMargin <= 0) {
      releaseOpenLock(lockKey);
      return res.status(400).json({ ok: false, error: "margin_invalid" });
    }

    if (freeMargin < requiredMargin) {
      releaseOpenLock(lockKey);
      return res.status(400).json({ ok: false, error: "insufficient_margin" });
    }

    const createdRecently = await Position.exists({
      user: user._id,
      symbol,
      side,
      status: "OPEN",
      createdAt: { $gte: new Date(Date.now() - OPEN_LOCK_TTL_MS) },
    }).catch(() => null);

    if (createdRecently) {
      releaseOpenLock(lockKey);
      return res.status(429).json({ ok: false, error: "duplicate_open_position_blocked" });
    }

    const updatedWallet = await Wallet.findOneAndUpdate(
      {
        user: user._id,
        balanceOwn: { $gte: requiredMargin },
      },
      {
        $inc: {
          balanceOwn: -requiredMargin,
          balance: -requiredMargin,
          marginUsed: requiredMargin,
        },
        $set: {
          updatedAt: new Date(),
        },
      },
      { new: true }
    ).catch(() => null);

    if (!updatedWallet) {
      releaseOpenLock(lockKey);
      return res.status(400).json({ ok: false, error: "insufficient_margin" });
    }

    const openPositions = await loadOpenPositionsForUser(user._id);
    const openPnl = (openPositions || []).reduce((sum, p) => sum + (Number(p.unrealizedPnl ?? p.pnl ?? 0) || 0), 0);

    updatedWallet.equity = Number(updatedWallet.balanceOwn || 0) + openPnl;
    updatedWallet.freeMargin = Math.max(updatedWallet.equity + credit - Number(updatedWallet.marginUsed || 0), 0);
    updatedWallet.marginLevel =
      Number(updatedWallet.marginUsed || 0) > 0
        ? (updatedWallet.equity / Number(updatedWallet.marginUsed || 0)) * 100
        : 0;

    await updatedWallet.save();

    user.balance = updatedWallet.balanceOwn;
    await user.save();

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
      clientOrderId: clientOrderId || undefined,
      sourcePriceUpdatedAt: quote.updatedAt,
      createdAt: new Date(),
    });

    const tx = await recordTransaction({
      user,
      type: "trade_open",
      amount: -requiredMargin,
      status: "completed",
      note: `${side} ${symbol}`,
      balanceBefore: balanceOwn,
      balanceAfter: updatedWallet.balanceOwn,
      meta: {
        positionId: String(position._id),
        symbol,
        side,
        qty,
        entryPrice: price,
        requiredMargin,
        leverage,
        clientOrderId: clientOrderId || null,
      },
      source: "api/trade/open",
    });

    const account = await buildAccountForUser(user);
    emitStateUpdates(user._id, account, [annotatePosition(position)], tx);

    return res.json({
      ok: true,
      msg: "OPENED",
      position: annotatePosition(position),
      wallet: account.wallet,
      account: account.account,
      transaction: tx,
      quote,
    });
  } catch (err) {
    console.error("/api/trade/open error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  } finally {
    try {
      const body = req.body || {};
      const clientOrderId = String(body.clientOrderId || body.orderId || body.id || "").trim();
      const symbol = normalizePositionSymbol(body);
      const side = normalizeSide(body.side);
      const lockKey = clientOrderId
        ? `cid:${String(req.user?._id || "")}:${clientOrderId}`
        : makeOpenLockKey(req.user?._id, symbol, side);
      releaseOpenLock(lockKey);
    } catch {}
  }
});

app.post("/api/trade/close", async (req, res) => {
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const { positionId } = req.body || {};
    if (!positionId) {
      return res.status(400).json({ ok: false, error: "positionId_required" });
    }

    const position = await Position.findOne({
      _id: positionId,
      user: user._id,
      status: "OPEN",
    });

    if (!position) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    const quote = getValidatedMarketPrice(position.symbol);
    const closePrice = quote?.price || Number(position.currentPrice || position.entryPrice || 0);

    if (!Number.isFinite(closePrice) || closePrice <= 0) {
      return res.status(400).json({ ok: false, error: "price_invalid_or_stale" });
    }

    const result = await applyCloseToPosition({
      user,
      positionDoc: position,
      currentPrice: closePrice,
      source: "api/trade/close",
    });

    return res.json({ ok: true, msg: "CLOSED", ...result });
  } catch (err) {
    console.error("/api/trade/close error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/trade/positions", async (req, res) => {
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const positions = await loadOpenPositionsForUser(user._id);
    return res.json({ ok: true, positions, data: positions, items: positions, count: positions.length });
  } catch (e) {
    console.error("/api/trade/positions error", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ======================================================
   PNL SYNC EN TIEMPO REAL
   ====================================================== */

async function syncOpenPositionsPnL() {
  try {
    const openPositions = await Position.find({ status: "OPEN" }).sort({ createdAt: -1 }).lean().exec().catch(() => []);
    if (!openPositions.length) return;

    for (const raw of openPositions) {
      const quote = getValidatedMarketPrice(raw.symbol);
      if (!quote) continue;

      const currentPrice = quote.price;
      const side = normalizeSide(raw.side || raw.direction);
      const entryPrice = Number(raw.entryPrice ?? raw.price ?? raw.openPrice ?? 0) || 0;
      const qty = Number(raw.qty ?? raw.quantity ?? raw.amount ?? 0) || 0;
      const sign = side === "SELL" ? -1 : 1;
      const pnl = (currentPrice - entryPrice) * qty * sign;

      await Position.updateOne(
        { _id: raw._id, status: "OPEN" },
        {
          $set: {
            currentPrice,
            pnl,
            unrealizedPnl: pnl,
            sourcePriceUpdatedAt: quote.updatedAt,
            updatedAt: new Date(),
          },
        }
      ).catch(() => null);

      io.emit("position:update", {
        _id: raw._id,
        user: raw.user,
        symbol: raw.symbol,
        side: raw.side,
        qty,
        entryPrice,
        currentPrice,
        pnl,
        unrealizedPnl: pnl,
        status: "OPEN",
      });
    }
  } catch (err) {
    console.warn("syncOpenPositionsPnL error:", err?.message || err);
  }
}

const pnlSyncIntervalMs = Number(process.env.PNL_SYNC_INTERVAL_MS) || 2000;
const pnlTimer = setInterval(syncOpenPositionsPnL, pnlSyncIntervalMs);
if (pnlTimer && typeof pnlTimer.unref === "function") pnlTimer.unref();
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

io.on("connection", (socket) => {
  console.log("📡 Cliente conectado:", socket.id);
  try { socket.emit("prices_snapshot", getPriceStore() || {}); } catch { socket.emit("prices_snapshot", {}); }

  socket.on("request_prices_snapshot", () => {
    try { socket.emit("prices_snapshot", getPriceStore() || {}); } catch { socket.emit("prices_snapshot", {}); }
  });

  socket.on("request_symbols", () => {
    try {
      const prices = getPriceStore();
      if (priceHandler && typeof priceHandler.getSymbols === "function") socket.emit("symbols_update", priceHandler.getSymbols() || []);
      else if (prices && Object.keys(prices).length) socket.emit("symbols_update", Object.keys(prices).map((k) => ({ symbol: k, label: (k.split(":").pop() || k).replace("_", "/"), market: prices[k]?.market || "Unknown" })));
      else socket.emit("symbols_update", SAMPLE_SYMBOLS);
    } catch { socket.emit("symbols_update", SAMPLE_SYMBOLS); }
  });

  socket.on("subscribe", ({ symbol, kind } = {}) => {
    if (!symbol) return;
    try {
      if (polygonSocket && typeof polygonSocket.subscribe === "function") polygonSocket.subscribe(symbol, kind);
      socket.join(symbol);
      console.log("subscribe:", socket.id, symbol, kind || "trades");
    } catch (e) { console.warn("subscribe error:", e); }
  });

  socket.on("unsubscribe", ({ symbol, kind } = {}) => {
    if (!symbol) return;
    try {
      if (polygonSocket && typeof polygonSocket.unsubscribe === "function") polygonSocket.unsubscribe(symbol, kind);
      socket.leave(symbol);
      console.log("unsubscribe:", socket.id, symbol, kind || "trades");
    } catch (e) { console.warn("unsubscribe error:", e); }
  });

  socket.on("disconnect", (reason) => console.log("❌ Cliente desconectado:", socket.id, "reason:", reason));
});

try {
  if (!process.env.POLYGON_API_KEY) {
    console.warn("⚠️ POLYGON_API_KEY no definido — realtime de mercado limitado");
  } else {
    polygonSocket = new PolygonSocket({
      apiKey: process.env.POLYGON_API_KEY,
      onPrice: (data) => priceHandler.handle(data),
      onOpen: () => console.log("PolygonSocket abierto"),
      onClose: () => console.log("PolygonSocket cerrado"),
      onError: (err) => console.error("PolygonSocket error:", err),
    });
    const maybe = polygonSocket.connect();
    if (maybe && typeof maybe.then === "function") {
      maybe.catch((err) => {
        console.warn("PolygonSocket.connect() rejected:", err);
        polygonSocket = null;
      });
    }
    console.log("🔌 Intentando conectar PolygonSocket...");
  }
} catch (err) {
  console.error("Error inicializando PolygonSocket:", err);
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

app.use("/api", (req, res) => res.status(404).json({ error: "API endpoint not found" }));

/* ======================================================
   START / SHUTDOWN
   ====================================================== */
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
