// server.js (CSP desactivado — versión limpia + depósitos admin + historial + balance real + PnL)
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
import accountRoutes from "./routes/account.routes.js";

import { startRiskWatcher } from "./jobs/risk.job.js";

// Realtime
import PolygonSocket from "./sockets/polygonSocket.js";
import PriceHandler from "./utils/priceHandler.js";
import marketRoutesFactory from "./routes/market.routes.js";

// Models
import User from "./models/user.model.js";
import Wallet from "./models/wallet.model.js";
import Position from "./models/position.model.js";

// Send email helper
import sendEmail from "./utils/sendEmail.js";

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ENV
dotenv.config({
  path:
    process.env.NODE_ENV === "production"
      ? undefined
      : path.resolve(__dirname, ".env"),
});

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

// DB CONNECT
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

/* ======================================================
   SECURITY MIDDLEWARES
   ====================================================== */
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(mongoSanitize());
app.use(xss());

/* ======================================================
   CORS - whitelist dinámico
   ====================================================== */
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

/* ======================================================
   BASIC MIDDLEWARES
   ====================================================== */
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} › ${req.method} ${req.originalUrl}`);
  next();
});
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

/* ======================================================
   RATE LIMIT
   ====================================================== */
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

/* ======================================================
   SOCKET.IO + PRICE HANDLER
   ====================================================== */
const httpServer = createServer(app);
const io = new IOServer(httpServer, {
  cors: {
    origin: Array.from(allowedOrigins).length ? Array.from(allowedOrigins) : process.env.CLIENT_URL || "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
});
const priceHandler = new PriceHandler(io);
let polygonSocket = null;

/* ======================================================
   HELPERS
   ====================================================== */
function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function compactSymbol(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function normalizeSide(value) {
  const s = String(value || "").trim().toUpperCase();
  if (!s) return "";
  if (["BUY", "LONG", "BULL"].includes(s)) return "BUY";
  if (["SELL", "SHORT", "BEAR"].includes(s)) return "SELL";
  return "";
}
function normalizeQty(body = {}) {
  const n = Number(body.qty ?? body.quantity ?? body.amount ?? body.positionSize ?? body.notional ?? body.size);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function normalizePrice(body = {}) {
  const raw = body.price ?? body.entryPrice ?? body.currentPrice ?? body.limitPrice ?? body.stopPrice ?? body.openPrice ?? null;
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
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
function normalizeQuote(symbol, item = {}) {
  const label = item.label || item.name || (symbol.split(":").pop() || symbol).replace("_", "/");
  const price = toNumber(item.price) ?? toNumber(item.last) ?? toNumber(item.close) ?? toNumber(item.value) ?? toNumber(item.mark) ?? toNumber(item.mid);
  return {
    symbol,
    label,
    market: item.market || "Unknown",
    price,
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
function getCurrentPriceForSymbol(symbol) {
  const target = compactSymbol(symbol);
  if (!target) return null;
  const store = getPriceStore();
  for (const [key, item] of Object.entries(store)) {
    const candidates = [key, key.split(":").pop(), item?.symbol, item?.tvSymbol, item?.ticker, item?.name, item?.label, item?.marketSymbol];
    if (candidates.some((c) => compactSymbol(c) === target)) {
      return toNumber(item?.price ?? item?.last ?? item?.close ?? item?.value ?? item?.mark ?? item?.mid ?? item?.lp) ?? null;
    }
  }
  return null;
}
function isClosedPosition(p = {}) {
  const status = String(p.status || p.state || p.positionStatus || "").toLowerCase().trim();
  return status.includes("close") || status === "closed" || !!p.closedAt || !!p.closed_at;
}
function computePositionPnl(position = {}, currentPrice = null) {
  const entry = toNumber(position.entryPrice ?? position.price ?? position.openPrice ?? 0) ?? 0;
  const qty = toNumber(position.qty ?? position.quantity ?? position.amount ?? position.positionSize ?? 0) ?? 0;
  const side = normalizeSide(position.side || position.direction || position.positionSide);
  const px = toNumber(currentPrice ?? position.currentPrice ?? entry) ?? entry;
  const sign = side === "SELL" ? -1 : 1;
  return ((px - entry) * qty) * sign;
}
function annotatePosition(position = {}) {
  const currentPrice = toNumber(position.currentPrice ?? getCurrentPriceForSymbol(position.symbol) ?? position.price ?? position.entryPrice ?? 0) ?? 0;
  const entryPrice = toNumber(position.entryPrice ?? position.price ?? position.openPrice ?? 0) ?? 0;
  const qty = toNumber(position.qty ?? position.quantity ?? position.amount ?? position.positionSize ?? 0) ?? 0;
  const pnl = isClosedPosition(position) ? (toNumber(position.realizedPnl ?? position.pnl ?? 0) ?? 0) : computePositionPnl({ ...position, entryPrice, qty }, currentPrice);
  return { ...position, entryPrice, currentPrice, qty, pnl, unrealizedPnl: pnl, isOpen: !isClosedPosition(position) };
}
async function getUserDocFromBearer(req) {
  try {
    const auth = req.headers.authorization || req.headers.Authorization || null;
    if (!auth || !auth.toLowerCase().startsWith("bearer ")) return null;
    const token = String(auth).split(" ")[1];
    if (!token || !process.env.JWT_SECRET) return null;
    let payload;
    try { payload = jwt.verify(token, process.env.JWT_SECRET); } catch { return null; }
    const userId = payload && (payload.id || payload.sub || payload.userId || payload._id);
    if (!userId) return null;
    return await User.findById(userId).catch(() => null);
  } catch { return null; }
}
async function getUserFromBearer(req) { return getUserDocFromBearer(req); }
async function getWalletDocForUser(userId) {
  try {
    let wallet = await Wallet.findOne({ user: userId }).catch(() => null);
    if (!wallet) {
      wallet = new Wallet({ user: userId, balanceOwn: 0, balance: 0, credit: 0, marginUsed: 0, leverageFactor: 1, equity: 0, freeMargin: 0, marginLevel: 0 });
    }
    return wallet;
  } catch { return null; }
}
function normalizeWalletSnapshot(wallet, openPnl = 0) {
  const balanceOwn = toNumber(wallet?.balanceOwn ?? wallet?.balance ?? 0) ?? 0;
  const credit = toNumber(wallet?.credit ?? 0) ?? 0;
  const marginUsed = Math.max(toNumber(wallet?.marginUsed ?? 0) ?? 0, 0);
  const equity = balanceOwn + openPnl;
  const freeMargin = Math.max(equity + credit - marginUsed, 0);
  const marginLevel = marginUsed > 0 ? (equity / marginUsed) * 100 : 0;
  return { balance: balanceOwn, balanceOwn, credit, equity, marginUsed, freeMargin, marginLevel, leverageFactor: toNumber(wallet?.leverageFactor ?? 1) ?? 1, currency: wallet?.currency || "USD", openPnl };
}
async function recordTransaction({ user, type, amount = 0, status = "completed", note = "", balanceBefore = 0, balanceAfter = 0, meta = {}, source = "server.js" }) {
  try {
    const payload = { user: user?._id || user?.user || user?.id || null, userId: String(user?._id || user?.user || user?.id || ""), type, amount: Number(amount) || 0, status, note, balanceBefore: Number(balanceBefore) || 0, balanceAfter: Number(balanceAfter) || 0, meta, source, createdAt: new Date() };
    const tx = await Transaction.create(payload);
    return tx.toObject ? tx.toObject() : tx;
  } catch (err) {
    console.warn("recordTransaction fallback:", err?.message || err);
    return { userId: String(user?._id || user?.user || user?.id || ""), type, amount: Number(amount) || 0, status, note, balanceBefore: Number(balanceBefore) || 0, balanceAfter: Number(balanceAfter) || 0, meta, source, createdAt: new Date().toISOString() };
  }
}
async function loadTransactionsForUser(userId, limit = 50) {
  try {
    return await Transaction.find({ user: userId }).sort({ createdAt: -1 }).limit(limit).lean().exec().catch(() => []) || [];
  } catch { return []; }
}
async function loadAllTransactions(limit = 200, userId = null) {
  try {
    const query = userId ? { user: userId } : {};
    return await Transaction.find(query).sort({ createdAt: -1 }).limit(limit).lean().exec().catch(() => []) || [];
  } catch { return []; }
}
async function loadOpenPositionsForUser(userId) {
  try {
    const rows = await Position.find({ user: userId, status: { $in: ["OPEN", "open", "Open"] } }).sort({ createdAt: -1 }).lean().exec().catch(() => []);
    return (rows || []).map(annotatePosition);
  } catch { return []; }
}
async function loadAllPositionsForUser(userId) {
  try {
    const rows = await Position.find({ user: userId }).sort({ createdAt: -1 }).lean().exec().catch(() => []);
    return (rows || []).map(annotatePosition);
  } catch { return []; }
}
async function getPositionsForUser(userId) { return loadOpenPositionsForUser(userId); }

// Rich account builder used by the operational routes
async function buildRichAccountForUser(userDoc) {
  const wallet = await getWalletDocForUser(userDoc._id);
  const openPositions = await loadOpenPositionsForUser(userDoc._id);
  const recentTransactions = await loadTransactionsForUser(userDoc._id, 20);
  const openPnl = openPositions.reduce((sum, p) => sum + (toNumber(p.pnl ?? 0) || 0), 0);
  const normalizedWallet = normalizeWalletSnapshot(wallet, openPnl);
  return {
    account: {
      ...normalizedWallet,
      leverage: toNumber(userDoc.leverage ?? wallet.leverageFactor ?? 100) ?? 100,
      currency: userDoc.currency || wallet.currency || "USD",
      positions: openPositions,
      openPositions,
      recentTransactions,
      transactions: recentTransactions,
    },
    user: userDoc.toObject ? userDoc.toObject() : userDoc,
    wallet: wallet.toObject ? wallet.toObject() : wallet,
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
  } catch (e) { console.warn("emitStateUpdates error:", e?.message || e); }
}

/* ======================================================
   Esta no se tocan parcher
   ====================================================== */
async function buildAccountForUser(user) {
  const wallet = await getWalletForUser(user._id);
  const positions = await getPositionsForUser(user._id);
  const balance = wallet?.balance ?? user.balance ?? 0;
  return {
    account: {
      balance,
      equity: balance,
      marginUsed: 0,
      freeMargin: balance,
      marginLevel: 0,
      leverage: user.leverage ?? 100,
      currency: user.currency || "USD",
      positions: positions || [],
    },
    user,
    wallet,
    positions,
  };
}
    
async function getWalletForUser(userId) {
  try {
    return await Wallet.findOne({ user: userId }).lean().exec().catch(() => null);
  } catch {
    return null;
  }
}

async function accountLikeHandler(req, res) {
  try {
    const user = await getUserFromBearer(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const payload = await buildAccountForUser(user);
    return res.json(payload);
  } catch (e) {
    console.error("accountLikeHandler error", e);
    return res.status(500).json({ error: "Server error" });
  }
}

/* ======================================================
   ya te dije no se tocan 
   ====================================================== */

/* ======================================================
   ADMIN AUTH
   ====================================================== */
async function requireAdmin(req, res, next) {
  try {
    const key = String(req.headers["x-admin-api-key"] || req.headers["x-admin-key"] || "");
    if (process.env.ADMIN_API_KEY && key && key === process.env.ADMIN_API_KEY) return next();
    const user = await getUserDocFromBearer(req);
    if (user && (user.role === "admin" || user.isAdmin === true || user.admin === true)) { req.user = user; return next(); }
    if (!process.env.ADMIN_API_KEY && user) { req.user = user; return next(); }
    return res.status(401).json({ ok: false, error: "Admin unauthorized" });
  } catch (err) {
    console.error("requireAdmin error:", err);
    return res.status(401).json({ ok: false, error: "Admin unauthorized" });
  }
}

/* ======================================================
   HEALTH CHECK
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

/* ======================================================
   SEND EMAIL HELPER
   ====================================================== */
app.locals.sendEmail = sendEmail;
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
   MARKET SAMPLE / FALLBACK
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
function buildMarketPayload() {
  const store = getPriceStore();
  const keys = Object.keys(store);
  const quotes = keys.length
    ? keys.map((symbol) => normalizeQuote(symbol, store[symbol] || {}))
    : SAMPLE_SYMBOLS.map((s) => normalizeQuote(s.symbol, { label: s.label, market: s.market, price: null, updatedAt: new Date().toISOString() }));
  return { ok: true, count: quotes.length, quotes, data: quotes, items: quotes, latest: quotes[0] || null, symbols: quotes.map((q) => ({ symbol: q.symbol, label: q.label, market: q.market })) };
}
app.get("/api/markets", (req, res) => res.json({ markets: ["Crypto", "Stocks", "Forex", "Indices", "Futures", "Bonds"] }));
app.get("/api/market/list", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/market/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/markets/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/api/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/api/markets", (req, res) => res.json({ markets: ["Crypto", "Stocks", "Forex", "Indices"] }));
app.get("/api/quotes", (req, res) => res.json(buildMarketPayload()));
app.get("/api/market/quotes", (req, res) => res.json(buildMarketPayload()));
app.get("/api/price", (req, res) => res.json(buildMarketPayload()));
app.get("/api/prices", (req, res) => res.json(buildMarketPayload()));

/* ======================================================
   POLYGON SOCKET (realtime provider)
   ====================================================== */
try {
  if (!process.env.POLYGON_API_KEY) {
    console.warn("⚠️ POLYGON_API_KEY no definido — realtime de mercado no podrá conectarse");
  } else {
    polygonSocket = new PolygonSocket({
      apiKey: process.env.POLYGON_API_KEY,
      onPrice: (data) => priceHandler.handle(data),
      onOpen: () => console.log("PolygonSocket abierto"),
      onClose: () => console.log("PolygonSocket cerrado"),
      onError: (err) => console.error("PolygonSocket error:", err),
    });
    try {
      const maybe = polygonSocket.connect();
      if (maybe && typeof maybe.then === "function") {
        maybe.catch((err) => { console.warn("PolygonSocket.connect() rejected:", err); polygonSocket = null; });
      }
      console.log("🔌 Intentando conectar PolygonSocket...");
    } catch (err) {
      console.error("Error iniciando PolygonSocket.connect():", err);
      polygonSocket = null;
    }
  }
} catch (err) {
  console.error("Error inicializando PolygonSocket:", err);
  polygonSocket = null;
}

/* ======================================================
   MARKET ROUTES (factory)
   ====================================================== */
try {
  if (typeof marketRoutesFactory === "function") {
    app.use("/api/market", marketRoutesFactory({ polygonSocket, priceHandler }));
  } else {
    app.use("/api/market", marketRoutesFactory);
  }
} catch (e) {
  console.warn("No se pudo montar /api/market:", e && e.message ? e.message : e);
}

/* ======================================================
   ACCOUNT / WALLET / TRANSACTIONS
   ====================================================== */
app.get("/api/account", accountLikeHandler);
app.get("/api/me", accountLikeHandler);
app.get("/api/profile", accountLikeHandler);
app.get("/api/cuenta", (req, res) => res.redirect(307, "/api/account"));

async function walletLikeHandler(req, res) {
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const payload = await buildRichAccountForUser(user);
    return res.json({ ok: true, wallet: payload.wallet, account: payload.account, balance: payload.account.balance, balanceOwn: payload.account.balanceOwn, equity: payload.account.equity, marginUsed: payload.account.marginUsed, freeMargin: payload.account.freeMargin, marginLevel: payload.account.marginLevel, leverageFactor: payload.account.leverageFactor, currency: payload.account.currency, transactions: payload.transactions });
  } catch (e) {
    console.error("/api/wallet error", e);
    return res.status(500).json({ error: "Server error" });
  }
}
app.get("/api/wallet", walletLikeHandler);
app.get("/api/billetera", (req, res) => res.redirect(307, "/api/wallet"));

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
app.get("/api/account/transactions", async (req, res) => {
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const limit = Math.min(Number(req.query.limit || 50) || 50, 200);
    const transactions = await loadTransactionsForUser(user._id, limit);
    return res.json({ ok: true, count: transactions.length, transactions, data: transactions, items: transactions });
  } catch (e) {
    console.error("/api/account/transactions error", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ======================================================
   ADMIN: DEPOSITS / HISTORY / ACCOUNT UPDATE
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
    const balanceBefore = toNumber(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) ?? 0;
    wallet.balanceOwn = balanceBefore + amount;
    wallet.balance = wallet.balanceOwn;
    wallet.currency = currency || wallet.currency || "USD";
    if (Number.isFinite(leverage) && leverage > 0) { wallet.leverageFactor = leverage; user.leverage = leverage; }
    wallet.equity = wallet.balanceOwn;
    wallet.marginUsed = toNumber(wallet.marginUsed ?? 0) ?? 0;
    wallet.freeMargin = Math.max(wallet.equity - wallet.marginUsed, 0);
    wallet.marginLevel = wallet.marginUsed > 0 ? (wallet.equity / wallet.marginUsed) * 100 : 0;
    wallet.updatedAt = new Date();
    await wallet.save();
    user.balance = wallet.balanceOwn;
    user.currency = currency || user.currency || "USD";
    if (Number.isFinite(leverage) && leverage > 0) user.leverage = leverage;
    await user.save();
    const tx = await recordTransaction({ user, type: "deposit", amount, status: "completed", note, balanceBefore, balanceAfter: wallet.balanceOwn, meta: { source: "admin-panel", method: body.method || "deposit", currency, leverage: wallet.leverageFactor }, source: "api/admin/deposit" });
    const account = await buildRichAccountForUser(user);
    emitStateUpdates(user._id, account, null, tx);
    return res.json({ ok: true, msg: "Depósito aplicado", data: { balance: wallet.balanceOwn, leverage: wallet.leverageFactor, transaction: tx, account: account.account, wallet: account.wallet } });
  } catch (err) {
    console.error("/api/admin/deposit error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  }
});

app.get("/api/admin/transactions", requireAdmin, async (req, res) => {
  try {
    const userId = req.query.userId || null;
    const limit = Math.min(Number(req.query.limit || 100) || 100, 500);
    const txs = await loadAllTransactions(limit, userId || null);
    return res.json({ ok: true, count: txs.length, transactions: txs, data: txs, items: txs });
  } catch (err) {
    console.error("/api/admin/transactions error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  }
});

// 🔧 SOLO TE DOY LAS PARTES CORREGIDAS — NO TOCO LO DEMÁS

/* ======================================================
   FIX PnL (CRÍTICO)
   ====================================================== */
function computePositionPnl(position = {}, currentPrice = null) {
  const entry = Number(position.entryPrice ?? position.price ?? 0);
  const qty = Number(position.qty ?? position.quantity ?? 0);
  const side = normalizeSide(position.side || position.direction);

  if (!entry || !qty || !side) return 0;

  const px = Number(currentPrice ?? entry);
  if (!Number.isFinite(px)) return 0;

  const sign = side === "SELL" ? -1 : 1;

  return (px - entry) * qty * sign;
}

/* ======================================================
   FIX ANNOTATE POSITION
   ====================================================== */
function annotatePosition(position = {}) {
  const entryPrice = Number(position.entryPrice ?? position.price ?? 0);

  const currentPrice =
    Number(position.currentPrice) ||
    getCurrentPriceForSymbol(position.symbol) ||
    entryPrice ||
    0;

  const qty = Number(position.qty ?? position.quantity ?? 0);

  const pnl = isClosedPosition(position)
    ? Number(position.realizedPnl || position.pnl || 0)
    : computePositionPnl(position, currentPrice);

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

/* ======================================================
   FIX WALLET SNAPSHOT
   ====================================================== */
function normalizeWalletSnapshot(wallet = {}, openPnl = 0) {
  const balanceOwn = Number(wallet.balanceOwn ?? wallet.balance ?? 0);
  const credit = Number(wallet.credit ?? 0);
  const marginUsed = Math.max(Number(wallet.marginUsed ?? 0), 0);

  const equity = balanceOwn + Number(openPnl || 0);
  const freeMargin = equity + credit - marginUsed;

  return {
    balance: balanceOwn,
    balanceOwn,
    credit,
    equity,
    marginUsed,
    freeMargin: Math.max(freeMargin, 0),
    marginLevel: marginUsed > 0 ? (equity / marginUsed) * 100 : 0,
    leverageFactor: Number(wallet.leverageFactor ?? 1),
    currency: wallet.currency || "USD",
    openPnl: Number(openPnl || 0),
  };
}

/* ======================================================
   FIX GET PRICE (MUY IMPORTANTE)
   ====================================================== */
function getCurrentPriceForSymbol(symbol) {
  const target = compactSymbol(symbol);
  if (!target) return null;

  const store = getPriceStore?.() || {};

  for (const [key, item] of Object.entries(store)) {
    const candidates = [
      key,
      item?.symbol,
      item?.ticker,
      item?.name,
      item?.label,
    ];

    if (candidates.some((c) => compactSymbol(c) === target)) {
      const price = Number(
        item?.price ??
        item?.last ??
        item?.close ??
        item?.mark ??
        item?.mid
      );

      return Number.isFinite(price) ? price : null;
    }
  }

  return null;
}

/* ======================================================
   FIX CLOSE ALL (BUG CRÍTICO)
   ====================================================== */
async function tradeCloseAllHandler(req, res) {
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ ok: false });

    const openPositions = await Position.find({
      user: user._id,
      status: { $in: ["OPEN", "open", "Open"] },
    });

    if (!openPositions.length)
      return res.json({ ok: true, closed: 0, totalPnl: 0 });

    const wallet = await getWalletDocForUser(user._id);

    let totalPnl = 0;

    for (const pos of openPositions) {
      const currentPrice =
        getCurrentPriceForSymbol(pos.symbol) || pos.entryPrice || 0;

      const pnl = computePositionPnl(pos, currentPrice);
      totalPnl += pnl;

      wallet.marginUsed =
        Math.max(Number(wallet.marginUsed ?? 0) - Number(pos.marginReserved ?? 0), 0);

      pos.status = "CLOSED";
      pos.closePrice = currentPrice;
      pos.realizedPnl = pnl;
      pos.pnl = pnl;
      pos.closedAt = new Date();

      await pos.save();
    }

    wallet.balanceOwn = Number(wallet.balanceOwn ?? wallet.balance ?? 0) + totalPnl;
    wallet.balance = wallet.balanceOwn;
    wallet.marginUsed = Math.max(wallet.marginUsed, 0);
    wallet.equity = wallet.balanceOwn;

    await wallet.save();

    return res.json({
      ok: true,
      totalPnl,
      balance: wallet.balanceOwn,
    });

  } catch (err) {
    console.error("close-all error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}
/* ======================================================
   TRADE OPEN / CLOSE / CLOSE ALL
   ====================================================== */
async function tradeOpenHandler(req, res) {
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    const body = req.body || {};
    const symbol = String(body.symbol || body.tvSymbol || body.ticker || body.asset || "").trim().toUpperCase();
    const side = normalizeSide(body.side ?? body.direction ?? body.action);
    const qty = normalizeQty(body);
    const type = String(body.type ?? body.orderType ?? "market").trim().toLowerCase();
    if (!symbol) return res.status(400).json({ ok: false, error: "symbol_required", message: "symbol es requerido" });
    if (!side) return res.status(400).json({ ok: false, error: "side_required", message: "side/direction debe ser BUY o SELL" });
    if (!qty) return res.status(400).json({ ok: false, error: "quantity_required", message: "qty/quantity/amount es requerido y debe ser mayor que 0" });
    const wallet = await getWalletDocForUser(user._id);
    const leverage = Math.max(toNumber(body.leverage ?? body.leverageFactor ?? wallet.leverageFactor ?? user.leverage ?? 1) || 1, 1);
    const marketPrice = getCurrentPriceForSymbol(symbol);
    const requestedPrice = normalizePrice(body);
    let entryPrice = type === "limit" && requestedPrice ? requestedPrice : marketPrice || requestedPrice;
    if (!entryPrice || !Number.isFinite(entryPrice) || entryPrice <= 0) return res.status(400).json({ ok: false, error: "price_unavailable", message: "No hay precio disponible para este símbolo" });
    const balanceOwn = toNumber(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) ?? 0;
    const credit = toNumber(wallet.credit ?? 0) ?? 0;
    const marginUsed = toNumber(wallet.marginUsed ?? 0) ?? 0;
    const freeMargin = balanceOwn + credit - marginUsed;
    const notional = Math.abs(qty * entryPrice);
    const requiredMargin = notional / leverage;
    if (freeMargin < requiredMargin) return res.status(400).json({ ok: false, error: "insufficient_funds", message: "Fondos insuficientes para abrir la operación", freeMargin, requiredMargin });
    wallet.balanceOwn = balanceOwn;
    wallet.balance = balanceOwn;
    wallet.marginUsed = marginUsed + requiredMargin;
    wallet.equity = balanceOwn;
    wallet.freeMargin = Math.max(wallet.equity + credit - wallet.marginUsed, 0);
    wallet.marginLevel = wallet.marginUsed > 0 ? (wallet.equity / wallet.marginUsed) * 100 : 0;
    wallet.leverageFactor = leverage;
    wallet.updatedAt = new Date();
    await wallet.save();
    user.balance = balanceOwn;
    user.leverage = leverage;
    await user.save();
    const position = await Position.create({ user: user._id, symbol, side, qty, entryPrice, currentPrice: entryPrice, marginReserved: requiredMargin, leverage, status: "OPEN", createdAt: new Date(), updatedAt: new Date() });
    const tx = await recordTransaction({ user, type: "trade_open", amount: requiredMargin, status: "reserved", note: `${side} ${symbol}`, balanceBefore: balanceOwn, balanceAfter: balanceOwn, meta: { symbol, side, qty, leverage, entryPrice, currentPrice: entryPrice, marginReserved: requiredMargin }, source: "api/trade/open" });
    const account = await buildRichAccountForUser(user);
    const annotatedPosition = annotatePosition(position.toObject ? position.toObject() : position);
    emitStateUpdates(user._id, account, [annotatedPosition], tx);
    return res.status(201).json({ ok: true, msg: "Operación abierta", data: { positionId: position._id, status: "OPEN", symbol: annotatedPosition.symbol, side: annotatedPosition.side, qty: annotatedPosition.qty, entryPrice: annotatedPosition.entryPrice, currentPrice: annotatedPosition.currentPrice, marginReserved: requiredMargin, leverage, account: account.account, wallet: account.wallet, position: annotatedPosition, transaction: tx } });
  } catch (err) {
    console.error("/api/trade/open error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  }
}
async function tradeCloseHandler(req, res) {
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    const body = req.body || {};
    const positionId = body.positionId || body.id || body._id || body.tradeId || null;
    const symbol = String(body.symbol || "").trim().toUpperCase();
    let position = null;
    if (positionId) position = await Position.findOne({ _id: positionId, user: user._id, status: { $in: ["OPEN", "open", "Open"] } }).catch(() => null);
    if (!position && symbol) position = await Position.findOne({ user: user._id, symbol, status: { $in: ["OPEN", "open", "Open"] } }).sort({ createdAt: -1 }).catch(() => null);
    if (!position) return res.status(404).json({ ok: false, error: "position_not_found", message: "Posición no encontrada" });
    const currentPriceRaw = body.currentPrice ?? getCurrentPriceForSymbol(position.symbol) ?? position.currentPrice ?? position.entryPrice ?? 0;
    const currentPrice = toNumber(currentPriceRaw) ?? 0;
    const entryPrice = toNumber(position.entryPrice ?? position.price ?? position.openPrice ?? 0) ?? 0;
    const qty = toNumber(position.qty ?? position.quantity ?? position.amount ?? 0) ?? 0;
    const side = normalizeSide(position.side || position.direction);
    const sign = side === "SELL" ? -1 : 1;
    const realizedPnl = ((currentPrice - entryPrice) * qty) * sign;
    const wallet = await getWalletDocForUser(user._id);
    const balanceBefore = toNumber(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) ?? 0;
    const marginUsedBefore = toNumber(wallet.marginUsed ?? 0) ?? 0;
    const reservedMargin = toNumber(position.marginReserved ?? 0) ?? 0;
    wallet.marginUsed = Math.max(marginUsedBefore - reservedMargin, 0);
    wallet.balanceOwn = balanceBefore + realizedPnl;
    wallet.balance = wallet.balanceOwn;
    wallet.equity = wallet.balanceOwn;
    wallet.freeMargin = Math.max(wallet.equity - wallet.marginUsed, 0);
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
    await position.save();
    const tx = await recordTransaction({ user, type: "trade_close", amount: realizedPnl, status: "completed", note: `${side} ${position.symbol}`, balanceBefore, balanceAfter: wallet.balanceOwn, meta: { positionId: String(position._id), symbol: position.symbol, side, qty, entryPrice, closePrice: currentPrice, marginReleased: reservedMargin, realizedPnl }, source: "api/trade/close" });
    const account = await buildRichAccountForUser(user);
    const annotatedPosition = annotatePosition(position.toObject ? position.toObject() : position);
    emitStateUpdates(user._id, account, [annotatedPosition], tx);
    return res.json({ ok: true, msg: "Posición cerrada", data: { positionId: position._id, symbol: annotatedPosition.symbol, side: annotatedPosition.side, qty: annotatedPosition.qty, entryPrice, currentPrice, realizedPnl, balance: wallet.balanceOwn, account: account.account, wallet: account.wallet, position: annotatedPosition, transaction: tx } });
  } catch (err) {
    console.error("/api/trade/close error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  }
}
async function tradeCloseAllHandler(req, res) {
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    const openPositions = await Position.find({ user: user._id, status: { $in: ["OPEN", "open", "Open"] } }).sort({ createdAt: -1 }).catch(() => []);
    if (!openPositions.length) return res.json({ ok: true, msg: "No hay posiciones abiertas", closed: 0, totalRealized: 0 });
    let totalRealized = 0;
    const closed = [];
    for (const pos of openPositions) {
      const currentPrice = toNumber(req.body?.currentPrice ?? getCurrentPriceForSymbol(pos.symbol) ?? pos.currentPrice ?? pos.entryPrice ?? 0) ?? 0;
      const entryPrice = toNumber(pos.entryPrice ?? pos.price ?? pos.openPrice ?? 0) ?? 0;
      const qty = toNumber(pos.qty ?? pos.quantity ?? pos.amount ?? 0) ?? 0;
      const side = normalizeSide(pos.side || pos.direction);
      const sign = side === "SELL" ? -1 : 1;
      const realizedPnl = ((currentPrice - entryPrice) * qty) * sign;
      const wallet = await getWalletDocForUser(user._id);
      const balanceBefore = toNumber(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) ?? 0;
      const reservedMargin = toNumber(pos.marginReserved ?? 0) ?? 0;
      wallet.marginUsed = Math.max((toNumber(wallet.marginUsed ?? 0) ?? 0) - reservedMargin, 0);
      wallet.balanceOwn = balanceBefore + realizedPnl;
      wallet.balance = wallet.balanceOwn;
      wallet.equity = wallet.balanceOwn;
      wallet.freeMargin = Math.max(wallet.equity - wallet.marginUsed, 0);
      wallet.marginLevel = wallet.marginUsed > 0 ? (wallet.equity / wallet.marginUsed) * 100 : 0;
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
      await pos.save();
      const tx = await recordTransaction({ user, type: "trade_close", amount: realizedPnl, status: "completed", note: `${side} ${pos.symbol}`, balanceBefore, balanceAfter: wallet.balanceOwn, meta: { positionId: String(pos._id), symbol: pos.symbol, side, qty, entryPrice, closePrice: currentPrice, marginReleased: reservedMargin, realizedPnl }, source: "api/trade/close-all" });
      totalRealized += realizedPnl;
      closed.push({ positionId: pos._id, symbol: pos.symbol, realizedPnl, transaction: tx });
    }
    const account = await buildRichAccountForUser(user);
    emitStateUpdates(user._id, account, closed, null);
    return res.json({ ok: true, msg: "Posiciones cerradas", closed: closed.length, totalRealized, data: { closed, totalRealized, account: account.account, wallet: account.wallet } });
  } catch (err) {
    console.error("/api/trade/close-all error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  }
}
app.post("/api/trade/open", tradeOpenHandler);
app.post("/api/trade/close", tradeCloseHandler);
app.post("/api/trade/close-all", tradeCloseAllHandler);
app.post("/api/order", tradeOpenHandler);
app.post("/api/orders", tradeOpenHandler);
app.post("/api/trade/order", tradeOpenHandler);
app.post("/api/trade/orders", tradeOpenHandler);

/* ======================================================
   SOCKET.IO EVENTS
   ====================================================== */
io.on("connection", (socket) => {
  console.log("📡 Cliente conectado:", socket.id);
  try { socket.emit("prices_snapshot", getPriceStore() || {}); } catch { socket.emit("prices_snapshot", {}); }
  socket.on("request_prices_snapshot", () => { try { socket.emit("prices_snapshot", getPriceStore() || {}); } catch { socket.emit("prices_snapshot", {}); } });
  socket.on("request_symbols", () => {
    try {
      const prices = getPriceStore();
      if (priceHandler && typeof priceHandler.getSymbols === "function") {
        socket.emit("symbols_update", priceHandler.getSymbols() || []);
      } else if (prices && Object.keys(prices).length) {
        socket.emit("symbols_update", Object.keys(prices).map((k) => ({ symbol: k, label: (k.split(":").pop() || k).replace("_", "/"), market: prices[k] && prices[k].market ? prices[k].market : "Unknown" })));
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

/* ======================================================
   STATIC FRONTEND
   ====================================================== */
const staticCandidates = ["public", "publico", "público", "Public", "Publico"];
let staticDirName = null;
for (const cand of staticCandidates) {
  const p = path.join(__dirname, cand);
  try { if (fs.existsSync(p) && fs.statSync(p).isDirectory()) { staticDirName = cand; break; } } catch {}
}
if (!staticDirName) {
  staticDirName = "public";
  console.warn(`WARN: No se encontró carpeta estática entre ${staticCandidates.join(", ")}. Usando fallback '${staticDirName}'. Asegúrate de que exista la carpeta con los assets (index.html).`);
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
  const endsWithScript = /<\/script>\s*$/i.test(trimmed);
  if (startsWithScript && endsWithScript) text = trimmed.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>\s*$/i, "");
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
  return [...new Set(candidates)].find((p) => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } });
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
    res.status(404).type("application/javascript; charset=utf-8").send(`
// JS missing: ${pathname}
console.error("JS missing: ${pathname}");
window.CATEGORIES = window.CATEGORIES || [];
window.SESSION_KEY = window.SESSION_KEY || "BROKERPRO_SESSION_USER";
window.API = window.API || "/api";
window.SOCKET_URL = window.SOCKET_URL || location.origin;
window._LEONES = window._LEONES || {};
window._LEONES_TRADING = window._LEONES_TRADING || {};
window._LEONES_TRADING.fetchPositions = window._LEONES_TRADING.fetchPositions || (async function () { return []; });
if (!window.loadPositions) { window.loadPositions = async function () { try { if (window._LEONES_TRADING && typeof window._LEONES_TRADING.fetchPositions === "function") return await window._LEONES_TRADING.fetchPositions(); } catch (e) { console.warn("loadPositions stub error", e); } return null; }; }
if (!window.loadRealQuotes) { window.loadRealQuotes = async function () { return null; }; }
`);
  } catch (err) {
    console.error("Error sirviendo JS:", err);
    res.status(500).type("application/javascript; charset=utf-8").send(`console.error("JS server error");`);
  }
});
app.use("/public", express.static(staticPath));
app.use("/js", express.static(jsDirPath));
app.use(express.static(staticPath));

/* ======================================================
   FALLBACK HTML
   ====================================================== */
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

app.use("/api", (req, res) => res.status(404).json({ error: "API endpoint not found" }));
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({ error: "Server error", message: process.env.NODE_ENV === "development" ? err.message : undefined });
});

/* ======================================================
   START SERVER
   ====================================================== */
const PORT = process.env.PORT || 3000;
const server = httpServer.listen(PORT, () => {
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

/* ======================================================
   GRACEFUL SHUTDOWN
   ====================================================== */
let shuttingDown = false;
const safeClosePolygonSocket = async () => {
  if (!polygonSocket) return;
  try {
    const maybe = polygonSocket.close();
    if (maybe && typeof maybe.then === "function") await maybe.catch((err) => console.warn("polygonSocket.close() rejected:", err));
  } catch (e) {
    console.warn("polygonSocket.close() threw:", e);
  }
};
const gracefulShutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`📴 ${signal} recibido. Cerrando...`);
  const timeout = setTimeout(() => { console.warn("Forzando cierre..."); process.exit(1); }, 30000);
  timeout.unref();
  try {
    await new Promise((resolve, reject) => { server.close((err) => { if (err) return reject(err); console.log("HTTP cerrado"); resolve(); }); });
    try { await safeClosePolygonSocket(); } catch (e) { console.warn("Error cerrando polygonSocket (await):", e); }
    try { if (typeof global?.stopRiskWatcher === "function") { try { global.stopRiskWatcher(); } catch (e) { console.warn("stopRiskWatcher threw:", e); } } } catch (e) { console.warn("Error deteniendo risk watcher:", e); }
    try { await mongoose.disconnect(); console.log("Mongo cerrado"); } catch (e) { console.warn("Error desconectando Mongo:", e); }
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
