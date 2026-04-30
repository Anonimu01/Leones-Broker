// server.js — versión reforzada para trading real
// - Corrige cálculo de precio por símbolo
// - Descuenta margen/saldo disponible al abrir
// - Calcula PnL en tiempo real desde el backend
// - Liquida ganancias/pérdidas al cerrar
// - Expone availableBalance/freeMargin para la UI

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
  return [...new Set([compactSymbol(raw), compactSymbol(afterColon), compactSymbol(afterSlash), compactSymbol(afterDash)].filter(Boolean))];
}

function normalizeSide(value) {
  const s = String(value || "").trim().toUpperCase();
  if (["BUY", "LONG", "BULL"].includes(s)) return "BUY";
  if (["SELL", "SHORT", "BEAR"].includes(s)) return "SELL";
  return "";
}

function normalizeQty(body = {}) {
  const n = Number(body.qty ?? body.quantity ?? body.amount ?? body.positionSize ?? body.notional ?? body.size);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizePrice(body = {}) {
  const raw =
    body.price ??
    body.entryPrice ??
    body.currentPrice ??
    body.limitPrice ??
    body.stopPrice ??
    body.openPrice ??
    body.tvPrice ??
    body.lastPrice ??
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
    ""
  ).trim().toUpperCase();
}

function resolveOrderPrice(body = {}, symbol = "") {
  const direct = normalizePrice(body);
  if (direct) return direct;

  const tvLike = Number(body.tvPrice ?? body.lastPrice ?? body.currentPrice ?? body.entryPrice);
  if (Number.isFinite(tvLike) && tvLike > 0) return tvLike;

  const market = getCurrentPriceForSymbol(symbol);
  if (market) return market;

  return null;
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
  return (
    toNumber(item.price) ??
    toNumber(item.last) ??
    toNumber(item.close) ??
    toNumber(item.value) ??
    toNumber(item.mark) ??
    toNumber(item.mid) ??
    null
  );
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
  const currentPrice = Number(position.currentPrice ?? getCurrentPriceForSymbol(position.symbol) ?? entryPrice) || entryPrice;
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
  const availableBalance = Math.max(balanceOwn + credit - marginUsed, 0);
  const freeMargin = availableBalance;
  const marginLevel = marginUsed > 0 ? (equity / marginUsed) * 100 : 0;

  return {
    balance: balanceOwn,
    balanceOwn,
    credit,
    equity,
    marginUsed,
    freeMargin,
    availableBalance,
    marginLevel,
    leverageFactor: Number(wallet?.leverageFactor ?? 1) || 1,
    currency: wallet?.currency || "USD",
    openPnl,
  };
}

function getEffectiveBalance(userDoc, walletDoc) {
  const walletBalance = Number(walletDoc?.balanceOwn ?? walletDoc?.balance);
  const userBalance = Number(userDoc?.balanceOwn ?? userDoc?.balance);
  if (Number.isFinite(walletBalance) && walletBalance > 0) return walletBalance;
  if (Number.isFinite(userBalance) && userBalance > 0) return userBalance;
  return 0;
}

async function recordTransaction({ user, type, amount = 0, status = "completed", note = "", balanceBefore = 0, balanceAfter = 0, meta = {}, source = "server.js" }) {
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
  const Transaction = mongoose.models.Transaction;
  if (!Transaction) return [];
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
  const positions = await loadAllPositionsForUser(userDoc._id);
  const recentTransactions = await loadTransactionsForUser(userDoc._id, 20);
  const walletSnapshot = wallet?.toObject ? wallet.toObject() : wallet;
  const balance = getEffectiveBalance(userDoc, walletSnapshot);
  const openPnl = (positions || []).reduce((sum, p) => sum + (Number(p.pnl ?? 0) || 0), 0);
  const normalizedWallet = normalizeWalletSnapshot(walletSnapshot ? { ...walletSnapshot, balanceOwn: balance, balance } : { balanceOwn: balance, balance }, openPnl);

  return {
    account: {
      ...normalizedWallet,
      balance,
      balanceOwn: balance,
      availableBalance: normalizedWallet.availableBalance,
      equity: balance + openPnl,
      leverage: Number(userDoc.leverage ?? walletSnapshot?.leverageFactor ?? 100) || 100,
      currency: userDoc.currency || walletSnapshot?.currency || "USD",
      positions,
      openPositions: positions,
      recentTransactions,
      transactions: recentTransactions,
      openPnl,
    },
    user: userDoc.toObject ? userDoc.toObject() : userDoc,
    wallet: walletSnapshot,
    positions,
    transactions: recentTransactions,
  };
}

async function getUserFromBearer(req) {
  return await getUserDocFromBearer(req);
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
app.get("/api/markets", (req, res) =>
  res.json({ markets: ["Crypto", "Stocks", "Forex", "Indices", "Futures", "Bonds"] })
);

app.get("/api/market/list", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/market/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/markets/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/api/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/api/markets", (req, res) =>
  res.json({ markets: ["Crypto", "Stocks", "Forex", "Indices"] })
);

try {
  if (typeof marketRoutesFactory === "function") {
    app.use("/api/market", marketRoutesFactory({ polygonSocket: null, priceHandler }));
  } else {
    app.use("/api/market", marketRoutesFactory);
  }
} catch (e) {
  console.warn("No se pudo montar /api/market:", e && e.message ? e.message : e);
}

app.get("/api/quotes", (req, res) => res.json(buildMarketPayload().quotes));

app.get("/api/latest", (req, res) => {
  try {
    const symbol = String(
      req.query.symbol || req.query.tvSymbol || req.query.selectedSymbol || ""
    ).trim();

    if (symbol) {
      const price = getCurrentPriceForSymbol(symbol);
      return res.json({
        ok: true,
        symbol,
        price,
        last: price,
        currentPrice: price,
        close: price,
        updatedAt: new Date().toISOString(),
      });
    }

    return res.json(buildMarketPayload().latest || {});
  } catch (e) {
    console.error("/api/latest error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/market/quotes", (req, res) => res.json(buildMarketPayload()));

app.get("/api/market/latest", (req, res) => {
  try {
    const symbol = String(
      req.query.symbol || req.query.tvSymbol || req.query.selectedSymbol || ""
    ).trim();

    if (symbol) {
      const price = getCurrentPriceForSymbol(symbol);
      return res.json({
        ok: true,
        symbol,
        price,
        last: price,
        currentPrice: price,
        close: price,
        updatedAt: new Date().toISOString(),
      });
    }

    return res.json(buildMarketPayload().latest || {});
  } catch (e) {
    console.error("/api/market/latest error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/market/polygon/quotes", (req, res) => res.json(buildMarketPayload()));
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

/* ======================================================
   ACCOUNT / WALLET / POSITIONS
   ====================================================== */
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

app.get("/api/me", async (req, res) =>
  res.status(200).json(
    await (async () => {
      const user = await getUserDocFromBearer(req);
      if (!user) return { error: "Unauthorized" };
      return await buildAccountForUser(user);
    })()
  )
);

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

app.get("/api/cuenta", (req, res) => res.redirect(307, "/api/account"));

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
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/billetera", (req, res) => res.redirect(307, "/api/wallet"));

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

    wallet.equity = wallet.balanceOwn;
    wallet.marginUsed = Number(wallet.marginUsed ?? 0) || 0;
    wallet.freeMargin = Math.max(wallet.equity + wallet.credit - wallet.marginUsed, 0);
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

    const account = await buildAccountForUser(user);
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
    wallet.equity = wallet.balanceOwn;
    wallet.freeMargin = Math.max(wallet.equity - (Number(wallet.marginUsed ?? 0) || 0), 0);
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

    const account = await buildAccountForUser(user);
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
    const Transaction = mongoose.models.Transaction;
    const txs = userId
      ? await loadTransactionsForUser(userId, limit)
      : Transaction
        ? await Transaction.find({}).sort({ createdAt: -1 }).limit(limit).lean().exec().catch(() => [])
        : [];
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
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const body = req.body || {};
    const symbol = normalizePositionSymbol(body);
    const side = normalizeSide(body.side ?? body.direction ?? body.action);
    const qty = normalizeQty(body);
    const type = String(body.type ?? body.orderType ?? "market").trim().toLowerCase();

    if (!symbol) return res.status(400).json({ ok: false, error: "symbol_required", message: "Símbolo requerido" });
    if (!side) return res.status(400).json({ ok: false, error: "side_required", message: "Dirección requerida" });
    if (!qty) return res.status(400).json({ ok: false, error: "quantity_required", message: "Cantidad requerida" });

    const wallet = await getWalletDocForUser(user._id);
    const walletSnapshot = wallet?.toObject ? wallet.toObject() : wallet;

    const balanceOwn = getEffectiveBalance(user, walletSnapshot);
    const credit = Number(walletSnapshot?.credit ?? user.credit ?? 0) || 0;
    const marginUsed = Number(walletSnapshot?.marginUsed ?? user.marginUsed ?? 0) || 0;
    const leverage = Math.max(
      Number(body.leverage ?? body.leverageFactor ?? walletSnapshot?.leverageFactor ?? user.leverage ?? 1) || 1,
      1
    );

    const entryPrice =
      type === "limit"
        ? resolveOrderPrice(body, symbol)
        : (resolveOrderPrice(body, symbol) || getCurrentPriceForSymbol(symbol));

    if (!entryPrice || entryPrice <= 0) {
      return res.status(400).json({ ok: false, error: "price_unavailable", message: "No hay precio disponible para este símbolo" });
    }

    const notional = Math.abs(qty * entryPrice);
    const requiredMargin = notional / leverage;
    const freeMargin = balanceOwn + credit - marginUsed;

    if (freeMargin < requiredMargin) {
      return res.status(400).json({
        ok: false,
        error: "insufficient_funds",
        message: "Fondos insuficientes para abrir la operación",
        balance: balanceOwn,
        freeMargin,
        requiredMargin,
      });
    }

    wallet.balanceOwn = balanceOwn;
    wallet.balance = balanceOwn;
    wallet.credit = credit;
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
      amount: requiredMargin,
      status: "reserved",
      note: `${side} ${symbol}`,
      balanceBefore: balanceOwn,
      balanceAfter: balanceOwn,
      meta: {
        symbol,
        side,
        qty,
        leverage,
        entryPrice,
        currentPrice: entryPrice,
        marginReserved: requiredMargin,
        sourceSymbol: body.tvSymbol || body.selectedSymbol || body.chartSymbol || null,
      },
      source: "api/trade/open",
    });

    const account = await buildAccountForUser(user);
    const annotatedPosition = annotatePosition(position.toObject ? position.toObject() : position);
    emitStateUpdates(user._id, account, [annotatedPosition], tx);

    return res.status(201).json({
      ok: true,
      msg: "Operación abierta",
      data: {
        positionId: position._id,
        status: "OPEN",
        symbol: annotatedPosition.symbol,
        side: annotatedPosition.side,
        qty: annotatedPosition.qty,
        entryPrice: annotatedPosition.entryPrice,
        currentPrice: annotatedPosition.currentPrice,
        marginReserved: requiredMargin,
        leverage,
        account: account.account,
        wallet: account.wallet,
        position: annotatedPosition,
        transaction: tx,
      },
    });
  } catch (err) {
    console.error("/api/trade/open error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
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
      position = await Position.findOne({
        _id: positionId,
        user: user._id,
        status: { $in: ["OPEN", "open", "Open"] },
      }).catch(() => null);
    }

    if (!position && symbol) {
      position = await Position.findOne({
        user: user._id,
        symbol,
        status: { $in: ["OPEN", "open", "Open"] },
      })
        .sort({ createdAt: -1 })
        .catch(() => null);
    }

    if (!position) {
      return res.status(404).json({ ok: false, error: "position_not_found", message: "Posición no encontrada" });
    }

    const currentPrice = Number(resolveOrderPrice(body, position.symbol) || getCurrentPriceForSymbol(position.symbol) || position.currentPrice || 0) || 0;
    if (!currentPrice || currentPrice <= 0) {
      return res.status(400).json({ ok: false, error: "price_unavailable", message: "No hay precio disponible para cerrar la posición" });
    }

    const entryPrice = Number(position.entryPrice ?? position.price ?? position.openPrice ?? 0) || 0;
    const qty = Number(position.qty ?? position.quantity ?? position.amount ?? 0) || 0;
    const side = normalizeSide(position.side || position.direction);
    const sign = side === "SELL" ? -1 : 1;
    const realizedPnl = ((currentPrice - entryPrice) * qty) * sign;

    const wallet = await getWalletDocForUser(user._id);
    const balanceBefore = Number(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) || 0;
    const reservedMargin = Number(position.marginReserved ?? 0) || 0;
    const marginUsedBefore = Number(wallet.marginUsed ?? 0) || 0;

    wallet.marginUsed = Math.max(marginUsedBefore - reservedMargin, 0);
    wallet.balanceOwn = balanceBefore + realizedPnl;
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
    await position.save();

    const tx = await recordTransaction({
      user,
      type: "trade_close",
      amount: realizedPnl,
      status: "completed",
      note: `${side} ${position.symbol}`,
      balanceBefore,
      balanceAfter: wallet.balanceOwn,
      meta: {
        positionId: String(position._id),
        symbol: position.symbol,
        side,
        qty,
        entryPrice,
        closePrice: currentPrice,
        marginReleased: reservedMargin,
        realizedPnl,
      },
      source: "api/trade/close",
    });

    const account = await buildAccountForUser(user);
    const annotatedPosition = annotatePosition(position.toObject ? position.toObject() : position);
    emitStateUpdates(user._id, account, [annotatedPosition], tx);

    return res.json({
      ok: true,
      msg: "Posición cerrada",
      data: {
        positionId: position._id,
        symbol: annotatedPosition.symbol,
        side: annotatedPosition.side,
        qty: annotatedPosition.qty,
        entryPrice,
        currentPrice,
        realizedPnl,
        balance: wallet.balanceOwn,
        account: account.account,
        wallet: account.wallet,
        position: annotatedPosition,
        transaction: tx,
      },
    });
  } catch (err) {
    console.error("/api/trade/close error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  }
});

app.post("/api/trade/close-all", async (req, res) => {
  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const body = req.body || {};
    const openPositions = await Position.find({
      user: user._id,
      status: { $in: ["OPEN", "open", "Open"] },
    })
      .sort({ createdAt: -1 })
      .catch(() => []);

    if (!openPositions.length) {
      return res.json({ ok: true, msg: "No hay posiciones abiertas", closed: 0, totalRealized: 0 });
    }

    let totalRealized = 0;
    const closed = [];

    for (const pos of openPositions) {
      const currentPrice = Number(resolveOrderPrice(body, pos.symbol) || getCurrentPriceForSymbol(pos.symbol) || pos.currentPrice || 0) || 0;
      if (!currentPrice || currentPrice <= 0) continue;

      const entryPrice = Number(pos.entryPrice ?? pos.price ?? pos.openPrice ?? 0) || 0;
      const qty = Number(pos.qty ?? pos.quantity ?? pos.amount ?? 0) || 0;
      const side = normalizeSide(pos.side || pos.direction);
      const sign = side === "SELL" ? -1 : 1;
      const realizedPnl = ((currentPrice - entryPrice) * qty) * sign;

      const wallet = await getWalletDocForUser(user._id);
      const balanceBefore = Number(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) || 0;
      const reservedMargin = Number(pos.marginReserved ?? 0) || 0;

      wallet.marginUsed = Math.max((Number(wallet.marginUsed ?? 0) || 0) - reservedMargin, 0);
      wallet.balanceOwn = balanceBefore + realizedPnl;
      wallet.balance = wallet.balanceOwn;
      wallet.equity = wallet.balanceOwn;
      wallet.freeMargin = Math.max(wallet.equity + (Number(wallet.credit ?? 0) || 0) - wallet.marginUsed, 0);
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

      const tx = await recordTransaction({
        user,
        type: "trade_close",
        amount: realizedPnl,
        status: "completed",
        note: `${side} ${pos.symbol}`,
        balanceBefore,
        balanceAfter: wallet.balanceOwn,
        meta: {
          positionId: String(pos._id),
          symbol: pos.symbol,
          side,
          qty,
          entryPrice,
          closePrice: currentPrice,
          marginReleased: reservedMargin,
          realizedPnl,
        },
        source: "api/trade/close-all",
      });

      totalRealized += realizedPnl;
      closed.push({ positionId: pos._id, symbol: pos.symbol, realizedPnl, transaction: tx });
    }

    const account = await buildAccountForUser(user);
    emitStateUpdates(user._id, account, closed, null);

    return res.json({
      ok: true,
      msg: "Posiciones cerradas",
      closed: closed.length,
      totalRealized,
      data: { closed, totalRealized, account: account.account, wallet: account.wallet },
    });
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

export default app;
