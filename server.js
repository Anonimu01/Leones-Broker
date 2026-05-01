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
    startRiskWatcher({ intervalMs, alertThreshold, closeThreshold });
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

const allowedOrigins = new Set([
  process.env.CLIENT_URL,
  process.env.BASE_URL,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:4000",
  "http://127.0.0.1:4000",
  "https://leones-broker.onrender.com",
].filter(Boolean));

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    try {
      const url = new URL(origin);
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return callback(null, true);
    } catch {}
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} › ${req.method} ${req.originalUrl}`);
  next();
});
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5000,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS",
  })
);

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

/* ================= HELPERS ================= */
const openTradeLocks = new Map();
const roundMoney = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100000000) / 100000000 : 0);

function makeOpenLockKey(userId) {
  return `OPEN:${String(userId || "")}`;
}
function withOpenLock(key, ttlMs = 2000) {
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
function compactSymbol(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function symbolVariants(value) {
  const raw = String(value || "").trim().toUpperCase();
  const afterColon = raw.includes(":") ? raw.split(":").pop() : raw;
  const afterSlash = afterColon.includes("/") ? afterColon.split("/").join("") : afterColon;
  const afterDash = afterSlash.includes("-") ? afterSlash.split("-").join("") : afterSlash;
  return [...new Set([compactSymbol(raw), compactSymbol(afterColon), compactSymbol(afterSlash), compactSymbol(afterDash)].filter(Boolean))];
}
function normalizeSide(value) {
  const s = String(value || "").trim().toUpperCase();
  if (["BUY", "LONG", "BULL", "CALL"].includes(s)) return "BUY";
  if (["SELL", "SHORT", "BEAR", "PUT"].includes(s)) return "SELL";
  return "";
}
function normalizeQty(body = {}) {
  const n = Number(body.qty ?? body.quantity ?? body.amount ?? body.positionSize ?? body.notional ?? body.size ?? body.volume ?? body.lots ?? body.contracts ?? body.units ?? body.lotSize);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function normalizePrice(body = {}) {
  const raw = body.price ?? body.entryPrice ?? body.entry_price ?? body.currentPrice ?? body.current_price ?? body.limitPrice ?? body.limit_price ?? body.stopPrice ?? body.stop_price ?? body.openPrice ?? body.open_price ?? body.tvPrice ?? body.tv_price ?? body.lastPrice ?? body.last_price ?? body.marketPrice ?? body.market_price ?? body.quotePrice ?? body.quote_price ?? body.executionPrice ?? body.execution_price ?? body.ask ?? body.bid ?? body.mark ?? null;
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function normalizePositionSymbol(body = {}) {
  return String(body.symbol || body.tvSymbol || body.selectedSymbol || body.chartSymbol || body.instrument || body.marketSymbol || body.market || body.ticker || body.asset || "").trim().toUpperCase();
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
  const direct = toNumber(item.price) ?? toNumber(item.last) ?? toNumber(item.close) ?? toNumber(item.value) ?? toNumber(item.mark) ?? toNumber(item.mid);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const ask = toNumber(item.ask);
  const bid = toNumber(item.bid);
  if (Number.isFinite(ask) && Number.isFinite(bid) && ask > 0 && bid > 0) return (ask + bid) / 2;
  return null;
}
function normalizeQuote(symbol, item = {}) {
  const label = item.label || item.name || (symbol.split(":").pop() || symbol).replace("_", "/");
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
  return SAMPLE_SYMBOLS.map((s) => normalizeQuote(s.symbol, { label: s.label, market: s.market, price: null, updatedAt: new Date().toISOString() }));
}
function buildMarketPayload() {
  const quotes = buildQuotesArray();
  return { ok: true, count: quotes.length, quotes, data: quotes, items: quotes, latest: quotes[0] || null };
}
function getCurrentPriceForSymbol(symbol) {
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
    if (Number.isFinite(px) && px > 0) return px;
  }
  return null;
}
function resolveOrderPrice(body = {}, symbol = "") {
  const direct = normalizePrice(body);
  if (direct) return direct;
  const candidates = [body.currentPrice, body.current_price, body.lastPrice, body.last_price, body.tvPrice, body.tv_price, body.entry, body.entryPrice, body.entry_price, body.marketPrice, body.market_price, body.quotePrice, body.quote_price, body.executionPrice, body.execution_price];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return getCurrentPriceForSymbol(symbol);
}
function isClosedPosition(p = {}) {
  const status = String(p.status || p.state || p.positionStatus || "").toLowerCase().trim();
  return status.includes("close") || status === "closed" || !!p.closedAt || !!p.closed_at;
}
function computePositionPnl(position = {}, currentPrice = null) {
  const entry = Number(position.entryPrice ?? position.price ?? position.openPrice ?? 0) || 0;
  const qty = Number(position.qty ?? position.quantity ?? position.amount ?? position.positionSize ?? 0) || 0;
  const side = normalizeSide(position.side || position.direction || position.positionSide);
  const px = Number(currentPrice ?? position.currentPrice ?? getCurrentPriceForSymbol(position.symbol) ?? entry) || entry;
  const sign = side === "SELL" ? -1 : 1;
  const pnl = (px - entry) * qty * sign;
  return Number.isFinite(pnl) ? roundMoney(pnl) : 0;
}
function annotatePosition(position = {}) {
  const entryPrice = Number(position.entryPrice ?? position.price ?? position.openPrice ?? 0) || 0;
  const currentPrice = Number(position.currentPrice ?? getCurrentPriceForSymbol(position.symbol) ?? entryPrice) || entryPrice;
  const qty = Number(position.qty ?? position.quantity ?? position.amount ?? position.positionSize ?? 0) || 0;
  const pnl = isClosedPosition(position) ? Number(position.realizedPnl ?? position.pnl ?? 0) || 0 : computePositionPnl({ ...position, entryPrice, qty }, currentPrice);
  return { ...position, entryPrice, currentPrice, qty, pnl, pnlColor: pnl >= 0 ? "green" : "red", unrealizedPnl: pnl, isOpen: !isClosedPosition(position) };
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
  if (!wallet) wallet = new Wallet({ user: userId, balanceOwn: 0, balance: 0, credit: 0, marginUsed: 0, leverageFactor: 1, equity: 0, freeMargin: 0, marginLevel: 0 });
  return wallet;
}
function normalizeWalletSnapshot(wallet, openPnl = 0) {
  const balanceOwn = Number(wallet?.balanceOwn ?? wallet?.balance ?? 0) || 0;
  const credit = Number(wallet?.credit ?? 0) || 0;
  const marginUsed = Math.max(Number(wallet?.marginUsed ?? 0) || 0, 0);
  const equity = roundMoney(balanceOwn + openPnl);
  const freeMargin = roundMoney(Math.max(equity + credit - marginUsed, 0));
  const marginLevel = marginUsed > 0 ? roundMoney((equity / marginUsed) * 100) : 0;
  return { balance: balanceOwn, balanceOwn, credit, equity, marginUsed, freeMargin, availableBalance: freeMargin, marginLevel, leverageFactor: Number(wallet?.leverageFactor ?? 1) || 1, currency: wallet?.currency || "USD", openPnl };
}
function getEffectiveBalance(userDoc, walletDoc) {
  const walletBalance = Number(walletDoc?.balanceOwn ?? walletDoc?.balance);
  const userBalance = Number(userDoc?.balanceOwn ?? userDoc?.balance);
  if (Number.isFinite(walletBalance)) return walletBalance;
  if (Number.isFinite(userBalance)) return userBalance;
  return 0;
}
const transactionSchema = new mongoose.Schema({ user: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }, userId: { type: String, index: true }, type: { type: String, index: true }, amount: { type: Number, default: 0 }, status: { type: String, default: "completed" }, note: { type: String, default: "" }, balanceBefore: { type: Number, default: 0 }, balanceAfter: { type: Number, default: 0 }, meta: { type: mongoose.Schema.Types.Mixed, default: {} }, source: { type: String, default: "server.js" }, createdAt: { type: Date, default: Date.now } }, { minimize: false });
const Transaction = mongoose.models.Transaction || mongoose.model("Transaction", transactionSchema);
async function recordTransaction({ user, type, amount = 0, status = "completed", note = "", balanceBefore = 0, balanceAfter = 0, meta = {}, source = "server.js" }) {
  try {
    const tx = await Transaction.create({ user: user?._id || null, userId: String(user?._id || ""), type, amount: Number(amount) || 0, status, note, balanceBefore: Number(balanceBefore) || 0, balanceAfter: Number(balanceAfter) || 0, meta, source, createdAt: new Date() });
    return tx.toObject ? tx.toObject() : tx;
  } catch (err) {
    console.warn("recordTransaction fallback:", err?.message || err);
    return { userId: String(user?._id || ""), type, amount: Number(amount) || 0, status, note, balanceBefore: Number(balanceBefore) || 0, balanceAfter: Number(balanceAfter) || 0, meta, source, createdAt: new Date().toISOString() };
  }
}
async function loadTransactionsForUser(userId, limit = 50) {
  return await Transaction.find({ user: userId }).sort({ createdAt: -1 }).limit(limit).lean().exec().catch(() => []);
}
async function loadOpenPositionsForUser(userId) {
  const rows = await Position.find({ user: userId, status: { $in: ["OPEN", "open", "Open"] } }).sort({ createdAt: -1 }).lean().exec().catch(() => []);
  return (rows || []).map(annotatePosition);
}
async function loadAllPositionsForUser(userId) {
  const rows = await Position.find({ user: userId }).sort({ createdAt: -1 }).lean().exec().catch(() => []);
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
  const normalizedWallet = normalizeWalletSnapshot(walletSnapshot ? { ...walletSnapshot, balanceOwn: balance, balance } : { balanceOwn: balance, balance }, openPnl);
  return {
    account: {
      ...normalizedWallet,
      balance,
      balanceOwn: balance,
      availableBalance: normalizedWallet.availableBalance,
      equity: roundMoney(balance + openPnl),
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
async function requireAdmin(req, res, next) {
  try {
    const key = String(req.headers["x-admin-api-key"] || req.headers["x-admin-key"] || "");
    if (process.env.ADMIN_API_KEY && key && key === process.env.ADMIN_API_KEY) return next();
    const user = await getUserDocFromBearer(req);
    if (user && (user.role === "admin" || user.isAdmin === true || user.admin === true)) {
      req.user = user;
      return next();
    }
    return res.status(401).json({ ok: false, error: "Admin unauthorized" });
  } catch {
    return res.status(401).json({ ok: false, error: "Admin unauthorized" });
  }
}

async function recalculateUserRisk(userId, { liquidateIfNeeded = true, emit = true } = {}) {
  const wallet = await getWalletDocForUser(userId);
  const walletObj = wallet?.toObject ? wallet.toObject() : wallet;
  const openPositions = await Position.find({ user: userId, status: { $in: ["OPEN", "open", "Open"] } }).sort({ createdAt: -1 }).lean().exec().catch(() => []);
  const annotated = (openPositions || []).map(annotatePosition);
  const openPnl = annotated.reduce((sum, p) => sum + (Number(p.unrealizedPnl ?? p.pnl ?? 0) || 0), 0);
  const balanceOwn = Number(walletObj?.balanceOwn ?? walletObj?.balance ?? 0) || 0;
  const credit = Number(walletObj?.credit ?? 0) || 0;
  const marginUsed = Math.max(Number(walletObj?.marginUsed ?? 0) || 0, 0);
  const equity = roundMoney(balanceOwn + openPnl);
  const freeMargin = roundMoney(Math.max(equity + credit - marginUsed, 0));
  const marginLevel = marginUsed > 0 ? roundMoney((equity / marginUsed) * 100) : 0;

  wallet.balanceOwn = balanceOwn;
  wallet.balance = balanceOwn;
  wallet.equity = equity;
  wallet.freeMargin = freeMargin;
  wallet.availableBalance = freeMargin;
  wallet.marginUsed = marginUsed;
  wallet.marginLevel = marginLevel;
  wallet.updatedAt = new Date();
  await wallet.save();

  if (emit) {
    const user = await User.findById(userId).catch(() => null);
    if (user) {
      const payload = await buildAccountForUser(user);
      emitStateUpdates(userId, payload, annotated, null);
    }
  }

  if (marginLevel > 0 && marginLevel < 50) {
    io.emit("margin_warning", { userId: String(userId), marginLevel, equity, marginUsed, openPnl });
  }

  if (liquidateIfNeeded && marginLevel > 0 && marginLevel < 20) {
    await liquidateAllOpenPositions(userId, { reason: "margin_call" });
  }

  return { openPnl, equity, freeMargin, marginLevel, marginUsed, balanceOwn, credit, positions: annotated };
}

async function liquidateAllOpenPositions(userId, { reason = "liquidation" } = {}) {
  const user = await User.findById(userId).catch(() => null);
  if (!user) return { ok: false, closed: 0, totalRealized: 0 };

  const openPositions = await Position.find({ user: userId, status: { $in: ["OPEN", "open", "Open"] } }).sort({ createdAt: -1 }).exec().catch(() => []);
  if (!openPositions.length) return { ok: true, closed: 0, totalRealized: 0 };

  const wallet = await getWalletDocForUser(userId);
  let totalRealized = 0;
  let balanceOwn = Number(wallet.balanceOwn ?? wallet.balance ?? 0) || 0;
  let marginUsed = Number(wallet.marginUsed ?? 0) || 0;
  const credit = Number(wallet.credit ?? 0) || 0;
  const closed = [];

  for (const posDoc of openPositions) {
    const pos = posDoc.toObject ? posDoc.toObject() : posDoc;
    const priceRaw = resolveOrderPrice({ currentPrice: pos.currentPrice, price: pos.closePrice, entryPrice: pos.entryPrice }, pos.symbol);
    const price = Number.isFinite(Number(priceRaw)) && Number(priceRaw) > 0 ? Number(priceRaw) : Number(pos.currentPrice ?? pos.entryPrice ?? 0) || 0;
    const entryPrice = Number(pos.entryPrice ?? pos.price ?? pos.openPrice ?? 0) || 0;
    const qty = Number(pos.qty ?? pos.quantity ?? pos.amount ?? 0) || 0;
    const side = normalizeSide(pos.side || pos.direction);
    const sign = side === "SELL" ? -1 : 1;
    const realizedPnl = roundMoney((price - entryPrice) * qty * sign);
    const reservedMargin = Number(pos.marginReserved ?? 0) || 0;
    const balanceBefore = balanceOwn;

    balanceOwn = roundMoney(balanceOwn + reservedMargin + realizedPnl);
    marginUsed = Math.max(roundMoney(marginUsed - reservedMargin), 0);

    posDoc.status = "CLOSED";
    posDoc.currentPrice = price;
    posDoc.closePrice = price;
    posDoc.realizedPnl = realizedPnl;
    posDoc.pnl = realizedPnl;
    posDoc.closedAt = new Date();
    posDoc.updatedAt = new Date();
    await posDoc.save();

    const tx = await recordTransaction({
      user,
      type: "trade_close",
      amount: realizedPnl,
      status: "completed",
      note: `${reason}: ${side} ${pos.symbol}`,
      balanceBefore,
      balanceAfter: balanceOwn,
      meta: { positionId: String(pos._id), symbol: pos.symbol, side, qty, entryPrice, closePrice: price, marginReleased: reservedMargin, realizedPnl, reason },
      source: "liquidateAllOpenPositions",
    });

    totalRealized += realizedPnl;
    closed.push({ positionId: pos._id, symbol: pos.symbol, realizedPnl, transaction: tx });
  }

  wallet.balanceOwn = balanceOwn;
  wallet.balance = balanceOwn;
  wallet.marginUsed = marginUsed;
  wallet.equity = balanceOwn;
  wallet.freeMargin = roundMoney(Math.max(balanceOwn + credit - marginUsed, 0));
  wallet.availableBalance = wallet.freeMargin;
  wallet.marginLevel = marginUsed > 0 ? roundMoney((wallet.equity / marginUsed) * 100) : 0;
  wallet.updatedAt = new Date();
  await wallet.save();
  user.balance = balanceOwn;
  await user.save();

  const payload = await buildAccountForUser(user);
  io.emit("margin_call", { userId: String(userId), reason, closed: closed.length, totalRealized });
  emitStateUpdates(userId, payload, closed, null);

  return { ok: true, closed: closed.length, totalRealized, closedPositions: closed, wallet: wallet.toObject ? wallet.toObject() : wallet };
}

async function refreshUsersForSymbol(symbol) {
  const target = normalizePositionSymbol({ symbol });
  if (!target) return;
  const userIds = await Position.distinct("user", { symbol: { $in: [target] }, status: { $in: ["OPEN", "open", "Open"] } }).catch(() => []);
  for (const userId of userIds || []) {
    await recalculateUserRisk(userId, { liquidateIfNeeded: true, emit: true });
  }
}

async function openPositionWithProtection(user, body) {
  const symbol = normalizePositionSymbol(body);
  const side = normalizeSide(body.side ?? body.direction ?? body.action);
  const qty = normalizeQty(body);
  const type = String(body.type ?? body.orderType ?? body.order_type ?? "market").trim().toLowerCase();
  if (!symbol || !side || !qty) {
    const err = new Error("invalid_params");
    err.status = 400;
    throw err;
  }

  const wallet = await getWalletDocForUser(user._id);
  const walletSnapshot = wallet?.toObject ? wallet.toObject() : wallet;
  const balanceOwn = getEffectiveBalance(user, walletSnapshot);
  const credit = Number(walletSnapshot?.credit ?? user.credit ?? 0) || 0;
  const marginUsed = Number(walletSnapshot?.marginUsed ?? user.marginUsed ?? 0) || 0;
  const leverage = Math.max(Number(body.leverage ?? body.leverageFactor ?? walletSnapshot?.leverageFactor ?? user.leverage ?? 1) || 1, 1);
  const entryPrice = resolveOrderPrice(body, symbol);
  if (!entryPrice || entryPrice <= 0) {
    const err = new Error("price_unavailable");
    err.status = 400;
    throw err;
  }

  const notional = roundMoney(Math.abs(qty * entryPrice));
  const requiredMargin = roundMoney(notional / leverage);
  const freeMargin = roundMoney(balanceOwn + credit - marginUsed);
  if (freeMargin < requiredMargin) {
    const err = new Error("insufficient_funds");
    err.status = 400;
    err.data = { balance: balanceOwn, freeMargin, requiredMargin, leverage, notional };
    throw err;
  }

  const duplicate = await Position.findOne({
    user: user._id,
    symbol,
    side,
    qty,
    status: { $in: ["OPEN", "open", "Open"] },
    createdAt: { $gte: new Date(Date.now() - 3000) },
  })
    .sort({ createdAt: -1 })
    .lean()
    .exec()
    .catch(() => null);
  if (duplicate) {
    const err = new Error("duplicate_order_blocked");
    err.status = 409;
    err.data = duplicate;
    throw err;
  }

  wallet.balanceOwn = roundMoney(balanceOwn - requiredMargin);
  wallet.balance = wallet.balanceOwn;
  wallet.credit = credit;
  wallet.marginUsed = roundMoney(marginUsed + requiredMargin);
  wallet.equity = wallet.balanceOwn;
  wallet.freeMargin = roundMoney(wallet.equity + credit - wallet.marginUsed);
  wallet.availableBalance = wallet.freeMargin;
  wallet.marginLevel = wallet.marginUsed > 0 ? roundMoney((wallet.equity / wallet.marginUsed) * 100) : 0;
  wallet.leverageFactor = leverage;
  wallet.updatedAt = new Date();
  await wallet.save();

  user.balance = wallet.balanceOwn;
  user.leverage = leverage;
  await user.save();

  const position = await Position.create({
    user: user._id,
    symbol,
    side,
    qty,
    entryPrice,
    currentPrice: entryPrice,
    marginReserved: requiredMargin,
    leverage,
    status: "OPEN",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const tx = await recordTransaction({
    user,
    type: "trade_open",
    amount: -Math.abs(requiredMargin),
    status: "reserved",
    note: `${side} ${symbol}`,
    balanceBefore: balanceOwn,
    balanceAfter: wallet.balanceOwn,
    meta: { symbol, side, qty, leverage, entryPrice, currentPrice: entryPrice, marginReserved: requiredMargin, notional, sourceSymbol: body.tvSymbol || body.selectedSymbol || body.chartSymbol || null, orderType: type },
    source: "api/trade/open",
  });

  return { position, tx, wallet, requiredMargin, leverage, entryPrice, symbol, side, qty };
}

async function closePositionWithProtection(user, positionDoc, body = {}, source = "api/trade/close") {
  const pos = positionDoc?.toObject ? positionDoc.toObject() : positionDoc;
  const priceRaw = resolveOrderPrice(body, pos.symbol);
  const currentPrice = Number.isFinite(Number(priceRaw)) && Number(priceRaw) > 0 ? Number(priceRaw) : Number(pos.currentPrice ?? pos.entryPrice ?? 0) || 0;
  if (!currentPrice || currentPrice <= 0) {
    const err = new Error("price_unavailable");
    err.status = 400;
    throw err;
  }

  const entryPrice = Number(pos.entryPrice ?? pos.price ?? pos.openPrice ?? 0) || 0;
  const qty = Number(pos.qty ?? pos.quantity ?? pos.amount ?? 0) || 0;
  const side = normalizeSide(pos.side || pos.direction);
  const sign = side === "SELL" ? -1 : 1;
  const realizedPnl = roundMoney((currentPrice - entryPrice) * qty * sign);

  const wallet = await getWalletDocForUser(user._id);
  let balanceOwn = Number(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) || 0;
  let marginUsed = Number(wallet.marginUsed ?? 0) || 0;
  const credit = Number(wallet.credit ?? 0) || 0;
  const reservedMargin = Number(pos.marginReserved ?? 0) || 0;
  const balanceBefore = balanceOwn;

  balanceOwn = roundMoney(balanceOwn + reservedMargin + realizedPnl);
  marginUsed = Math.max(roundMoney(marginUsed - reservedMargin), 0);

  wallet.balanceOwn = balanceOwn;
  wallet.balance = balanceOwn;
  wallet.marginUsed = marginUsed;
  wallet.equity = wallet.balanceOwn;
  wallet.freeMargin = roundMoney(wallet.equity + credit - wallet.marginUsed);
  wallet.availableBalance = wallet.freeMargin;
  wallet.marginLevel = wallet.marginUsed > 0 ? roundMoney((wallet.equity / wallet.marginUsed) * 100) : 0;
  wallet.updatedAt = new Date();
  await wallet.save();

  user.balance = wallet.balanceOwn;
  await user.save();

  pos.status = "CLOSED";
  pos.currentPrice = currentPrice;
  pos.closePrice = currentPrice;
  pos.realizedPnl = realizedPnl;
  pos.pnl = realizedPnl;
  pos.closedAt = new Date();
  pos.updatedAt = new Date();
  await positionDoc.save();

  const tx = await recordTransaction({
    user,
    type: "trade_close",
    amount: realizedPnl,
    status: "completed",
    note: `${side} ${pos.symbol}`,
    balanceBefore,
    balanceAfter: wallet.balanceOwn,
    meta: { positionId: String(pos._id), symbol: pos.symbol, side, qty, entryPrice, closePrice: currentPrice, marginReleased: reservedMargin, realizedPnl },
    source,
  });

  const payload = await buildAccountForUser(user);
  const annotatedPosition = annotatePosition(pos);
  emitStateUpdates(user._id, payload, [annotatedPosition], tx);

  return { positionId: pos._id, symbol: pos.symbol, side, qty, entryPrice, currentPrice, realizedPnl, balance: wallet.balanceOwn, account: payload.account, wallet: payload.wallet, position: annotatedPosition, transaction: tx };
}

/* ================= HEALTH / MAIL ================= */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV || "dev", emailProvider: process.env.RESEND_API_KEY ? "resend" : process.env.EMAIL_USER || process.env.SMTP_USER ? "smtp" : "none", db: mongoose.connection.name || null, adminApiKeyConfigured: !!process.env.ADMIN_API_KEY });
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

/* ================= MARKET ROUTES ================= */
app.get("/api/markets", (_req, res) => res.json({ markets: ["Crypto", "Stocks", "Forex", "Indices", "Futures", "Bonds"] }));
app.get("/api/market/list", (_req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/market/symbols", (_req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/markets/symbols", (_req, res) => res.json(SAMPLE_SYMBOLS));
try {
  if (typeof marketRoutesFactory === "function") app.use("/api/market", marketRoutesFactory({ polygonSocket: null, priceHandler }));
  else app.use("/api/market", marketRoutesFactory);
} catch (e) {
  console.warn("No se pudo montar /api/market:", e && e.message ? e.message : e);
}
app.get("/api/quotes", (_req, res) => res.json(buildMarketPayload().quotes));
app.get("/api/latest", (req, res) => {
  try {
    const symbol = String(req.query.symbol || req.query.tvSymbol || req.query.selectedSymbol || "").trim();
    if (symbol) {
      const price = getCurrentPriceForSymbol(symbol);
      return res.json({ ok: true, symbol, price, last: price, currentPrice: price, close: price, updatedAt: new Date().toISOString() });
    }
    return res.json(buildMarketPayload().latest || {});
  } catch (e) {
    console.error("/api/latest error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});
app.get("/api/market/quotes", (_req, res) => res.json(buildMarketPayload()));
app.get("/api/market/latest", (req, res) => {
  try {
    const symbol = String(req.query.symbol || req.query.tvSymbol || req.query.selectedSymbol || "").trim();
    if (symbol) {
      const price = getCurrentPriceForSymbol(symbol);
      return res.json({ ok: true, symbol, price, last: price, currentPrice: price, close: price, updatedAt: new Date().toISOString() });
    }
    return res.json(buildMarketPayload().latest || {});
  } catch (e) {
    console.error("/api/market/latest error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});
app.get("/api/market/polygon/quotes", (_req, res) => res.json(buildMarketPayload()));
app.get("/api/market/polygon/symbols", (_req, res) => res.json(SAMPLE_SYMBOLS));
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

/* ================= ACCOUNT / WALLET / POSITIONS ================= */
app.get("/api/account", async (req, res) => {
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    return res.json(await buildAccountForUser(user));
  } catch (e) {
    console.error("account error", e);
    return res.status(500).json({ error: "Server error" });
  }
});
app.get("/api/me", async (req, res) => {
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    return res.status(200).json(await buildAccountForUser(user));
  } catch (e) {
    console.error("/api/me error", e);
    return res.status(500).json({ error: "Server error" });
  }
});
app.get("/api/profile", async (req, res) => {
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    return res.json(await buildAccountForUser(user));
  } catch (e) {
    console.error("profile error", e);
    return res.status(500).json({ error: "Server error" });
  }
});
app.get("/api/cuenta", (_req, res) => res.redirect(307, "/api/account"));
app.get("/api/transactions", async (req, res) => {
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const limit = Math.min(Number(req.query.limit || 50) || 50, 200);
    const transactions = await loadTransactionsForUser(user._id, limit);
    return res.json({ ok: true, count: transactions.length, transactions, data: transactions, items: transactions });
  } catch (e) {
    console.error("/api/transactions error", e);
    return res.status(500).json({ error: "Server error" });
  }
});
app.get("/api/wallet", async (req, res) => {
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const payload = await buildAccountForUser(user);
    return res.json({ ok: true, wallet: payload.wallet, account: payload.account, balance: payload.account.balance, balanceOwn: payload.account.balanceOwn, availableBalance: payload.account.availableBalance, equity: payload.account.equity, marginUsed: payload.account.marginUsed, freeMargin: payload.account.freeMargin, marginLevel: payload.account.marginLevel, leverageFactor: payload.account.leverageFactor, currency: payload.account.currency, transactions: payload.transactions });
  } catch (e) {
    console.error("/api/wallet error", e);
    return res.status(500).json({ error: "Server error" });
  }
});
app.get("/api/billetera", (_req, res) => res.redirect(307, "/api/wallet"));
app.get("/api/positions", async (req, res) => {
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const positions = await loadOpenPositionsForUser(user._id);
    return res.json({ ok: true, positions, data: positions, items: positions, count: positions.length });
  } catch (e) {
    console.error("/api/positions error", e);
    return res.status(500).json({ error: "Server error" });
  }
});
app.get("/api/positions/all", async (req, res) => {
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const positions = await loadAllPositionsForUser(user._id);
    return res.json({ ok: true, positions, data: positions, items: positions, count: positions.length });
  } catch (e) {
    console.error("/api/positions/all error", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ================= ADMIN ================= */
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
    wallet.balanceOwn = roundMoney(balanceBefore + amount);
    wallet.balance = wallet.balanceOwn;
    wallet.currency = currency || wallet.currency || "USD";
    if (Number.isFinite(leverage) && leverage > 0) {
      wallet.leverageFactor = leverage;
      user.leverage = leverage;
    }
    wallet.equity = wallet.balanceOwn;
    wallet.marginUsed = Number(wallet.marginUsed ?? 0) || 0;
    wallet.freeMargin = roundMoney(Math.max(wallet.equity + wallet.credit - wallet.marginUsed, 0));
    wallet.availableBalance = wallet.freeMargin;
    wallet.updatedAt = new Date();
    await wallet.save();
    user.balance = wallet.balanceOwn;
    user.currency = currency || user.currency || "USD";
    if (Number.isFinite(leverage) && leverage > 0) user.leverage = leverage;
    await user.save();
    const tx = await recordTransaction({ user, type: "deposit", amount, status: "completed", note, balanceBefore, balanceAfter: wallet.balanceOwn, meta: { source: "admin-panel", method: body.method || "deposit", currency, leverage: wallet.leverageFactor }, source: "api/admin/deposit" });
    const account = await buildAccountForUser(user);
    emitStateUpdates(user._id, account, null, tx);
    return res.json({ ok: true, msg: "Depósito aplicado", data: { balance: wallet.balanceOwn, leverage: wallet.leverageFactor, transaction: tx, account: account.account, wallet: account.wallet } });
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
    if (balanceBefore < amount) return res.status(400).json({ ok: false, error: "insufficient_balance", message: "Saldo insuficiente" });
    wallet.balanceOwn = roundMoney(balanceBefore - amount);
    wallet.balance = wallet.balanceOwn;
    wallet.equity = wallet.balanceOwn;
    wallet.freeMargin = roundMoney(Math.max(wallet.equity - (Number(wallet.marginUsed ?? 0) || 0), 0));
    wallet.availableBalance = wallet.freeMargin;
    wallet.updatedAt = new Date();
    await wallet.save();
    user.balance = wallet.balanceOwn;
    await user.save();
    const tx = await recordTransaction({ user, type: "withdrawal", amount: -Math.abs(amount), status: "completed", note, balanceBefore, balanceAfter: wallet.balanceOwn, meta: { source: "admin-panel" }, source: "api/admin/withdraw" });
    const account = await buildAccountForUser(user);
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
    const txs = userId ? await loadTransactionsForUser(userId, limit) : await Transaction.find({}).sort({ createdAt: -1 }).limit(limit).lean().exec().catch(() => []);
    return res.json({ ok: true, count: txs.length, transactions: txs, data: txs, items: txs });
  } catch (err) {
    console.error("/api/admin/transactions error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  }
});

/* ================= TRADING ================= */
app.post("/api/trade/open", async (req, res) => {
  const user = await getUserDocFromBearer(req);
  if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const lockKey = makeOpenLockKey(user._id);
  if (!withOpenLock(lockKey, 2500)) return res.status(429).json({ ok: false, error: "duplicate_order_blocked", message: "Ya hay una orden de apertura en proceso" });

  try {
    const result = await openPositionWithProtection(user, req.body || {});
    const account = await buildAccountForUser(user);
    const annotatedPosition = annotatePosition(result.position.toObject ? result.position.toObject() : result.position);
    emitStateUpdates(user._id, account, [annotatedPosition], result.tx);
    await recalculateUserRisk(user._id, { liquidateIfNeeded: true, emit: true });

    return res.status(201).json({
      ok: true,
      msg: "Operación abierta",
      data: {
        positionId: result.position._id,
        status: "OPEN",
        symbol: annotatedPosition.symbol,
        side: annotatedPosition.side,
        qty: annotatedPosition.qty,
        entryPrice: annotatedPosition.entryPrice,
        currentPrice: annotatedPosition.currentPrice,
        marginReserved: Number(result.requiredMargin),
        leverage: result.leverage,
        account: (await buildAccountForUser(user)).account,
        wallet: account.wallet,
        position: annotatedPosition,
        transaction: result.tx,
      },
    });
  } catch (err) {
    console.error("/api/trade/open error:", err);
    const status = err?.status || 500;
    return res.status(status).json({
      ok: false,
      error: err?.message || "server_error",
      message:
        err?.message === "insufficient_funds"
          ? "Fondos insuficientes para abrir la operación"
          : err?.message === "price_unavailable"
            ? "No hay precio disponible para este símbolo"
            : err?.message === "duplicate_order_blocked"
              ? "Se bloqueó una apertura duplicada"
              : "Error interno",
      data: err?.data || undefined,
    });
  } finally {
    releaseOpenLock(lockKey);
  }
});

app.post("/api/trade/close", async (req, res) => {
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    const body = req.body || {};
    const positionId = body.positionId || body.id || body._id || body.tradeId || null;
    const symbol = normalizePositionSymbol(body);
    let position = null;
    if (positionId) {
      position = await Position.findOne({ _id: positionId, user: user._id, status: { $in: ["OPEN", "open", "Open"] } }).catch(() => null);
    }
    if (!position && symbol) {
      position = await Position.findOne({ user: user._id, symbol, status: { $in: ["OPEN", "open", "Open"] } }).sort({ createdAt: -1 }).catch(() => null);
    }
    if (!position) return res.status(404).json({ ok: false, error: "position_not_found", message: "Posición no encontrada" });
    const result = await closePositionWithProtection(user, position, body, "api/trade/close");
    await recalculateUserRisk(user._id, { liquidateIfNeeded: true, emit: true });
    return res.json({ ok: true, msg: "Posición cerrada", data: result });
  } catch (err) {
    console.error("/api/trade/close error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  }
});

app.post("/api/trade/close-all", async (req, res) => {
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    const openPositions = await Position.find({ user: user._id, status: { $in: ["OPEN", "open", "Open"] } }).sort({ createdAt: -1 }).catch(() => []);
    if (!openPositions.length) return res.json({ ok: true, msg: "No hay posiciones abiertas", closed: 0, totalRealized: 0 });
    let totalRealized = 0;
    const closed = [];
    for (const pos of openPositions) {
      const result = await closePositionWithProtection(user, pos, {}, "api/trade/close-all");
      totalRealized += Number(result.realizedPnl || 0) || 0;
      closed.push({ positionId: result.positionId, symbol: result.symbol, realizedPnl: result.realizedPnl, transaction: result.transaction });
    }
    const payload = await buildAccountForUser(user);
    emitStateUpdates(user._id, payload, closed, null);
    return res.json({ ok: true, msg: "Posiciones cerradas", closed: closed.length, totalRealized, data: { closed, totalRealized, account: payload.account, wallet: payload.wallet } });
  } catch (err) {
    console.error("/api/trade/close-all error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
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

/* ================= MODULAR ROUTES ================= */
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/verification", verificationRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/positions", positionsRoutes);
app.use("/api/trade", tradeRoutes);
app.use("/api/account", accountRoutes);
app.use("/api/api", (req, res) => res.redirect(307, req.originalUrl.replace(/^\/api\/api/, "/api")));

/* ================= SOCKET.IO ================= */
let polygonSocket = null;
io.on("connection", (socket) => {
  console.log("📡 Cliente conectado:", socket.id);
  try {
    socket.emit("prices_snapshot", getPriceStore() || {});
  } catch {
    socket.emit("prices_snapshot", {});
  }
  socket.on("request_prices_snapshot", () => {
    try { socket.emit("prices_snapshot", getPriceStore() || {}); } catch { socket.emit("prices_snapshot", {}); }
  });
  socket.on("request_symbols", () => {
    try {
      const prices = getPriceStore();
      if (priceHandler && typeof priceHandler.getSymbols === "function") socket.emit("symbols_update", priceHandler.getSymbols() || []);
      else if (prices && Object.keys(prices).length) socket.emit("symbols_update", Object.keys(prices).map((k) => ({ symbol: k, label: (k.split(":").pop() || k).replace("_", "/"), market: prices[k]?.market || "Unknown" })));
      else socket.emit("symbols_update", SAMPLE_SYMBOLS);
    } catch {
      socket.emit("symbols_update", SAMPLE_SYMBOLS);
    }
  });
  socket.on("subscribe", ({ symbol, kind } = {}) => {
    if (!symbol) return;
    try {
      if (polygonSocket && typeof polygonSocket.subscribe === "function") polygonSocket.subscribe(symbol, kind);
      socket.join(symbol);
    } catch (e) {
      console.warn("subscribe error:", e);
    }
  });
  socket.on("unsubscribe", ({ symbol, kind } = {}) => {
    if (!symbol) return;
    try {
      if (polygonSocket && typeof polygonSocket.unsubscribe === "function") polygonSocket.unsubscribe(symbol, kind);
      socket.leave(symbol);
    } catch (e) {
      console.warn("unsubscribe error:", e);
    }
  });
});

try {
  if (!process.env.POLYGON_API_KEY) {
    console.warn("⚠️ POLYGON_API_KEY no definido — realtime de mercado limitado");
  } else {
    polygonSocket = new PolygonSocket({
      apiKey: process.env.POLYGON_API_KEY,
      onPrice: (data) => {
        try { priceHandler.handle(data); } catch (e) { console.warn("priceHandler.handle error:", e?.message || e); }
        const symbol = normalizePositionSymbol(data || {});
        if (symbol) void refreshUsersForSymbol(symbol).catch((e) => console.warn("refreshUsersForSymbol error:", e?.message || e));
      },
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

/* ================= STATIC ================= */
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
  if (req.path.startsWith("/api/") || req.path === "/api") return res.status(404).json({ error: "API endpoint not found" });
  const indexPath = path.join(staticPath, "index.html");
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error("Error sirviendo index.html:", err);
      res.status(err.status || 500).send("Error loading app");
    }
  });
});
app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint not found" }));

/* ================= START / SHUTDOWN ================= */
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
      await maybe.catch((err) => console.warn("polygonSocket.close() rejected:", err));
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
