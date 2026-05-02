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
const liveSyncTimers = new Map();

/* ---------------- LOCKS ---------------- */

function makeOpenLockKey(userId, symbol, side) {
  return `${String(userId || "")}:${String(symbol || "")}:${String(side || "")}`;
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

/* ---------------- SYMBOLS ---------------- */

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

  return [
    ...new Set([
      compactSymbol(raw),
      compactSymbol(afterColon),
      compactSymbol(afterSlash),
      compactSymbol(afterDash),
    ]),
  ].filter(Boolean);
}

function normalizeSide(value) {
  const s = String(value || "").trim().toUpperCase();
  if (["BUY", "LONG", "BULL", "CALL"].includes(s)) return "BUY";
  if (["SELL", "SHORT", "BEAR", "PUT"].includes(s)) return "SELL";
  return "";
}

/* ---------------- PRICE HELPERS ---------------- */

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
  return {
    symbol,
    label: item.label || symbol,
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
    updatedAt: item.updatedAt || new Date().toISOString(),
    raw: item,
  };
}

const SAMPLE_SYMBOLS = [
  { symbol: "BINANCE:BTCUSDT", label: "BTC/USDT", market: "Crypto" },
  { symbol: "BINANCE:ETHUSDT", label: "ETH/USDT", market: "Crypto" },
  { symbol: "OANDA:EUR_USD", label: "EUR/USD", market: "Forex" },
  { symbol: "NASDAQ:AAPL", label: "AAPL", market: "Stocks" },
  { symbol: "INDEX:SPX", label: "S&P 500", market: "Indices" },
];

function buildQuotesArray() {
  const store = getPriceStore();
  const keys = Object.keys(store);

  if (keys.length) {
    return keys.map((symbol) => normalizeQuote(symbol, store[symbol] || {}));
  }

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
  return { ok: true, count: quotes.length, quotes, data: quotes, items: quotes };
}

function getCurrentPriceForSymbol(symbol) {
  const targetVariants = symbolVariants(symbol);
  const store = getPriceStore();

  for (const [key, item] of Object.entries(store)) {
    const matched = [
      ...symbolVariants(key),
      ...symbolVariants(item?.symbol),
      ...symbolVariants(item?.label),
    ].some((v) => targetVariants.includes(v));

    if (!matched) continue;

    const px = extractQuotePrice(item);
    if (Number.isFinite(px) && px > 0) return px;
  }

  return 1;
}

/* ---------------- POSITION LOGIC ---------------- */

function isClosedPosition(p = {}) {
  const status = String(p.status || "").toLowerCase();
  return status.includes("close") || !!p.closedAt;
}

function computePositionPnl(position = {}, currentPrice = null) {
  const entry = Number(position.entryPrice ?? position.price ?? 0) || 0;
  const qty = Number(position.qty ?? position.quantity ?? 0) || 0;
  const side = normalizeSide(position.side || position.direction);
  const px = Number(currentPrice ?? entry) || entry;

  const sign = side === "SELL" ? -1 : 1;
  return (px - entry) * qty * sign;
}

function annotatePosition(position = {}) {
  const entryPrice = Number(position.entryPrice ?? position.price ?? 0) || 0;
  const currentPrice =
    Number(position.currentPrice ?? getCurrentPriceForSymbol(position.symbol)) || entryPrice;

  const qty = Number(position.qty ?? position.quantity ?? 0) || 0;

  const pnl = isClosedPosition(position)
    ? Number(position.realizedPnl ?? 0)
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
   PnL LIVE SYNC + SOCKET
   ====================================================== */

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
  }, 180);

  if (timer?.unref) timer.unref();
  liveSyncTimers.set(key, timer);
}

async function syncLivePnLForSymbol(symbol) {
  try {
    const variants = symbolVariants(symbol);
    if (!variants.length) return;

    const openRows = await Position.find({
      status: { $in: ["OPEN", "open"] },
      symbol: { $in: variants },
    }).lean();

    if (!openRows.length) return;

    const userIds = [...new Set(openRows.map((p) => String(p.user)))];

    for (const userId of userIds) {
      const user = await User.findById(userId);
      if (!user) continue;

      const account = await buildAccountForUser(user);
      emitStateUpdates(user._id, account, account.positions || [], null);
    }
  } catch (e) {
    console.warn("syncLivePnL failed:", e?.message || e);
  }
}

/* ======================================================
   SOCKET EMITTER (ÚNICO)
   ====================================================== */

function emitStateUpdates(userId, accountPayload = null, positions = null, transaction = null) {
  try {
    const account = accountPayload?.account || accountPayload;
    const payload = { userId, account };

    io.emit("wallet_update", payload);
    io.emit("account_update", payload);

    if (Array.isArray(positions)) {
      io.emit("positions_update", { userId, positions });
    }

    if (transaction) {
      io.emit("transactions_update", { userId, transaction });
    }

    if (userId) {
      const room = `user:${String(userId)}`;
      io.to(room).emit("wallet_update", payload);
      io.to(room).emit("account_update", payload);
      if (positions) io.to(room).emit("positions_update", { userId, positions });
      if (transaction) io.to(room).emit("transactions_update", { userId, transaction });
    }
  } catch (e) {
    console.warn("emitStateUpdates error:", e?.message || e);
  }
}

/* ======================================================
   CLOSE POSITION (ÚNICO Y CORREGIDO)
   ====================================================== */

async function applyCloseToPosition({ user, positionDoc, currentPrice, source = "api/trade/close" }) {
  const position = positionDoc.toObject ? positionDoc.toObject() : positionDoc;

  const symbol = String(position.symbol || "").toUpperCase();
  const side = normalizeSide(position.side || position.direction);

  const entryPrice = Number(position.entryPrice ?? position.price ?? 0) || 0;
  const qty = Number(position.qty ?? position.quantity ?? 0) || 0;

  const sign = side === "SELL" ? -1 : 1;
  const closePx = Number(currentPrice) || entryPrice;

  const realizedPnl = (closePx - entryPrice) * qty * sign;

  const wallet = await getWalletDocForUser(user._id);

  const balanceBefore = Number(wallet.balanceOwn ?? 0);

  const reserved = Number(position.marginReserved ?? 0);
  const marginUsedBefore = Number(wallet.marginUsed ?? 0);

  wallet.marginUsed = Math.max(marginUsedBefore - reserved, 0);
  wallet.balanceOwn = balanceBefore + reserved + realizedPnl;
  wallet.balance = wallet.balanceOwn;
  wallet.equity = wallet.balanceOwn;

  wallet.freeMargin = Math.max(wallet.equity - wallet.marginUsed, 0);
  wallet.marginLevel = wallet.marginUsed ? (wallet.equity / wallet.marginUsed) * 100 : 0;

  await wallet.save();

  user.balance = wallet.balanceOwn;
  await user.save();

  position.status = "CLOSED";
  position.currentPrice = closePx;
  position.closePrice = closePx;
  position.realizedPnl = realizedPnl;
  position.pnl = realizedPnl;
  position.closedAt = new Date();

  await positionDoc.save();

  const tx = await recordTransaction({
    user,
    type: "trade_close",
    amount: realizedPnl,
    balanceBefore,
    balanceAfter: wallet.balanceOwn,
    note: `${side} ${symbol}`,
    meta: { symbol, qty, entryPrice, closePrice: closePx },
    source,
  });

  const account = await buildAccountForUser(user);
  const annotated = annotatePosition(position);

  emitStateUpdates(user._id, account, [annotated], tx);

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
    position: annotated,
    transaction: tx,
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
    return res.status(400).json({ ok: false, message: "Necesitas enviar 'to' en el body o configurar SENDER_EMAIL" });
  const subject = req.body.subject || "Prueba de correo - Leones Broker";
  const html = req.body.html || `<p>Esto es una prueba desde el servidor de Leones Broker. Si recibes este correo, Resend/SMTP está funcionando.</p>`;
  try {
    const r = await sendEmail({ to, subject, html });
    if (r.ok)
      return res.json({ ok: true, message: "Correo enviado", provider: r.provider, result: r.result || r.info || r.resp });
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

app.get("/api/quotes", (req, res) => res.json(buildMarketPayload().quotes));

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

app.get("/api/market/quotes", (req, res) => res.json(buildMarketPayload()));
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

app.get("/api/market/polygon/quotes", (req, res) => res.json(buildMarketPayload()));
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
    return res.json({ ok: true, wallet: payload.wallet, account: payload.account, balance: payload.account.balance, balanceOwn: payload.account.balanceOwn, availableBalance: payload.account.availableBalance, equity: payload.account.equity, marginUsed: payload.account.marginUsed, freeMargin: payload.account.freeMargin, marginLevel: payload.account.marginLevel, leverageFactor: payload.account.leverageFactor, currency: payload.account.currency, transactions: payload.transactions });
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

async function requireAdmin(req, res, next) {
  try {
    const key = String(req.headers["x-admin-api-key"] || req.headers["x-admin-key"] || "");

    if (process.env.ADMIN_API_KEY && key && key === process.env.ADMIN_API_KEY) {
      return next();
    }

    const user = await getUserDocFromBearer(req);

    if (user && (user.role === "admin" || user.isAdmin === true || user.admin === true)) {
      req.user = user;
      return next();
    }

    return res.status(401).json({ ok: false, error: "Admin unauthorized" });
  } catch (err) {
    return res.status(401).json({ ok: false, error: "Admin unauthorized" });
  }
}

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
    if (Number.isFinite(leverage) && leverage > 0) { wallet.leverageFactor = leverage; user.leverage = leverage; }
    wallet.equity = wallet.balanceOwn;
    wallet.marginUsed = Number(wallet.marginUsed ?? 0) || 0;
    wallet.freeMargin = Math.max(wallet.equity + wallet.credit - wallet.marginUsed, 0);
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
    wallet.balanceOwn = balanceBefore - amount;
    wallet.balance = wallet.balanceOwn;
    wallet.equity = wallet.balanceOwn;
    wallet.freeMargin = Math.max(wallet.equity - (Number(wallet.marginUsed ?? 0) || 0), 0);
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
    const txs = userId
      ? await loadTransactionsForUser(userId, limit)
      : await Transaction.find({}).sort({ createdAt: -1 }).limit(limit).lean().exec().catch(() => []);
    return res.json({ ok: true, count: txs.length, transactions: txs, data: txs, items: txs });
  } catch (err) {
    console.error("/api/admin/transactions error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  }
});

/* ======================================================
   TRADING CORE (FIXED REAL LOGIC)
   ====================================================== */

// 🔒 Anti doble orden en memoria (simple pero efectivo)
const activeOrders = new Set();

app.post("/api/trade/open", async (req, res) => {
  let lockKey = null;

  try {
    const user = await getUserDocFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const body = req.body || {};
    const symbol = normalizePositionSymbol(body);
    const side = normalizeSide(body.side);
    const qty = normalizeQty(body);

    if (!symbol || !side || !qty) {
      return res.status(400).json({ ok: false, error: "invalid_params" });
    }

    lockKey = makeOpenLockKey(user._id, symbol, side);
    if (!withOpenLock(lockKey, 2500)) {
      return res.status(429).json({ ok: false, error: "duplicate_order_blocked" });
    }

    const wallet = await getWalletDocForUser(user._id);

    const balanceOwn = Number(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) || 0;
    const credit = Number(wallet.credit ?? 0) || 0;
    const marginUsed = Number(wallet.marginUsed ?? 0) || 0;
    const leverage = Math.max(Number(wallet.leverageFactor ?? user.leverage ?? 1) || 1, 1);

    const price = resolveOrderPrice(body, symbol) || getCurrentPriceForSymbol(symbol);
    if (!price || !Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ ok: false, error: "price_invalid" });
    }

    const notional = qty * price;
    const requiredMargin = notional / leverage;

    const freeMargin = balanceOwn + credit - marginUsed;

    if (freeMargin < requiredMargin) {
      return res.status(400).json({ ok: false, error: "insufficient_margin" });
    }

    wallet.balanceOwn = balanceOwn - requiredMargin;
    wallet.balance = wallet.balanceOwn;
    wallet.marginUsed = marginUsed + requiredMargin;
    wallet.equity = wallet.balanceOwn;
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

    const account = await buildAccountForUser(user);
    const annotatedPosition = annotatePosition(position.toObject ? position.toObject() : position);

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
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  } finally {
    if (lockKey) releaseOpenLock(lockKey);
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
    const price =
      resolveOrderPrice(body, position.symbol) ||
      getCurrentPriceForSymbol(position.symbol);

    if (!price || !Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ ok: false, error: "price_invalid" });
    }

    const result = await applyCloseToPosition({
      user,
      positionDoc: position,
      currentPrice: price,
      source: "api/trade/close",
    });

    scheduleLivePnLSync(position.symbol);

    return res.json({
      ok: true,
      msg: "CLOSED",
      ...result,
    });
  } catch (err) {
    console.error("/api/trade/close error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err?.message || "Error interno" });
  } finally {
    if (lockKey) releaseOpenLock(lockKey);
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

io.on("connection", (socket) => {
  console.log("📡 Cliente conectado:", socket.id);

  // Snapshot inicial de precios
  try {
    socket.emit("prices_snapshot", getPriceStore() || {});
  } catch {
    socket.emit("prices_snapshot", {});
  }

  // =====================================
  // REQUEST PRICES SNAPSHOT
  // =====================================
  socket.on("request_prices_snapshot", () => {
    try {
      socket.emit("prices_snapshot", getPriceStore() || {});
    } catch {
      socket.emit("prices_snapshot", {});
    }
  });

  // =====================================
  // REQUEST SYMBOLS
  // =====================================
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

  // =====================================
  // SUBSCRIBE MARKET
  // =====================================
  socket.on("subscribe", ({ symbol, kind } = {}) => {
    if (!symbol) return;

    try {
      if (polygonSocket && typeof polygonSocket.subscribe === "function") {
        polygonSocket.subscribe(symbol, kind);
      }

      socket.join(symbol);
      console.log("subscribe:", socket.id, symbol, kind || "trades");
    } catch (e) {
      console.warn("subscribe error:", e);
    }
  });

  // =====================================
  // UNSUBSCRIBE MARKET
  // =====================================
  socket.on("unsubscribe", ({ symbol, kind } = {}) => {
    if (!symbol) return;

    try {
      if (polygonSocket && typeof polygonSocket.unsubscribe === "function") {
        polygonSocket.unsubscribe(symbol, kind);
      }

      socket.leave(symbol);
      console.log("unsubscribe:", socket.id, symbol, kind || "trades");
    } catch (e) {
      console.warn("unsubscribe error:", e);
    }
  });

  // =====================================
  // DISCONNECT
  // =====================================
  socket.on("disconnect", (reason) => {
    console.log("❌ Cliente desconectado:", socket.id, "reason:", reason);
  });
});

/* ======================================================
   POLYGON SOCKET (REALTIME MARKET DATA)
   ====================================================== */

try {
  if (!process.env.POLYGON_API_KEY) {
    console.warn("⚠️ POLYGON_API_KEY no definido — realtime de mercado limitado");
  } else {
    polygonSocket = new PolygonSocket({
      apiKey: process.env.POLYGON_API_KEY,

      onPrice: async (data) => {
        try {
          priceHandler.handle(data);

          const rawSymbol =
            data?.symbol ||
            data?.ticker ||
            data?.tvSymbol ||
            data?.s ||
            data?.instrument ||
            "";

          if (rawSymbol) {
            scheduleLivePnLSync(rawSymbol);
          }
        } catch (err) {
          console.warn("onPrice handler error:", err?.message || err);
        }
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
