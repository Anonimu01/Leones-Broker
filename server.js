// server.js (CSP desactivado — versión limpia + Resend/SMTP sendEmail helper)
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

// Realtime
import PolygonSocket from "./sockets/polygonSocket.js";
import PriceHandler from "./utils/priceHandler.js";
import marketRoutesFactory from "./routes/market.routes.js";

// Models (used for account/wallet endpoints fallback)
import User from "./models/user.model.js";
import Wallet from "./models/wallet.model.js";
import Position from "./models/position.model.js";

// Send email helper (centralizado: Resend SDK / HTTP / SMTP fallback)
import sendEmail from "./utils/sendEmail.js";

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

// Mongoose listeners (logging + start jobs after DB ready)
mongoose.connection.on("connected", () => {
  console.log("✅ MongoDB conectado. DB:", mongoose.connection.name);

  try {
    const intervalMs = Number(process.env.RISK_JOB_INTERVAL_MS) || 30000;
    const alertThreshold = Number(process.env.RISK_ALERT_THRESHOLD) || 30;
    const closeThreshold = Number(process.env.RISK_CLOSE_THRESHOLD) || 15;

    startRiskWatcher({
      intervalMs,
      alertThreshold,
      closeThreshold,
    });

    console.log(
      `🛡️ Risk watcher iniciado (interval=${intervalMs}ms alert=${alertThreshold}% close=${closeThreshold}%)`
    );
  } catch (e) {
    console.error("Error iniciando risk watcher:", e);
  }
});

mongoose.connection.on("error", (err) => {
  console.error("❌ Mongo error:", err);
});

mongoose.connection.on("disconnected", () => {
  console.warn("⚠️ Mongo desconectado");
});

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
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
        return callback(null, true);
      }
    } catch (e) {}
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
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS",
});
app.use("/api", limiter);

/* ======================================================
   HEALTH CHECK
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

/* ======================================================
   SEND EMAIL HELPER
   ====================================================== */
app.locals.sendEmail = sendEmail;

app.locals.sendVerificationEmail = async ({ user, verificationLink }) => {
  try {
    const to = user?.email || user?.address || user;
    if (!to) {
      return { ok: false, error: "missing_recipient" };
    }
    if (!verificationLink) {
      return { ok: false, error: "missing_verification_link" };
    }

    const name = user?.name || "usuario";

    return await sendEmail({
      to,
      subject: "Verifica tu cuenta - Leones Broker",
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">
          <h2>Hola ${name}, verifica tu cuenta</h2>
          <p>Haz clic en el botón de abajo para activar tu cuenta:</p>
          <p>
            <a href="${verificationLink}"
               style="display:inline-block;background:#d4af37;color:#000;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold">
              Verificar cuenta
            </a>
          </p>
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

/* Endpoint de prueba para enviar correo */
app.post("/api/_send_test_email", async (req, res) => {
  const to = (req.body && req.body.to) || process.env.SENDER_EMAIL;
  if (!to) {
    return res.status(400).json({
      ok: false,
      message: "Necesitas enviar 'to' en el body o configurar SENDER_EMAIL",
    });
  }

  const subject = req.body.subject || "Prueba de correo - Leones Broker";
  const html =
    req.body.html ||
    `<p>Esto es una prueba desde el servidor de Leones Broker. Si recibes este correo, Resend/SMTP está funcionando.</p>`;

  try {
    const r = await sendEmail({ to, subject, html });
    if (r.ok) {
      return res.json({
        ok: true,
        message: "Correo enviado",
        provider: r.provider,
        result: r.result || r.info || r.resp,
      });
    }
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
   HELPERS DE TRADING / MARGEN
   ====================================================== */
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

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function compactSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeSide(value) {
  const s = String(value || "").trim().toUpperCase();
  if (!s) return "";
  if (["BUY", "LONG", "BULL"].includes(s)) return "BUY";
  if (["SELL", "SHORT", "BEAR"].includes(s)) return "SELL";
  return "";
}

function normalizeQty(body = {}) {
  const n = Number(
    body.qty ??
      body.quantity ??
      body.amount ??
      body.positionSize ??
      body.notional ??
      body.size
  );
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
    null;

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
  const label =
    item.label ||
    item.name ||
    (symbol.split(":").pop() || symbol).replace("_", "/");

  const price =
    toNumber(item.price) ??
    toNumber(item.last) ??
    toNumber(item.close) ??
    toNumber(item.value) ??
    toNumber(item.mark) ??
    toNumber(item.mid);

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
  const entries = Object.entries(store);

  for (const [key, item] of entries) {
    const candidates = [
      key,
      key.split(":").pop(),
      item?.symbol,
      item?.tvSymbol,
      item?.ticker,
      item?.name,
      item?.label,
      item?.marketSymbol,
    ];

    if (candidates.some((c) => compactSymbol(c) === target)) {
      return (
        toNumber(
          item?.price ??
            item?.last ??
            item?.close ??
            item?.value ??
            item?.mark ??
            item?.mid ??
            item?.lp
        ) ?? null
      );
    }
  }

  return null;
}

function isClosedPosition(p = {}) {
  const status = String(p.status || p.state || p.positionStatus || "")
    .toLowerCase()
    .trim();
  return (
    status.includes("close") ||
    status === "closed" ||
    !!p.closedAt ||
    !!p.closed_at
  );
}

function computePositionPnl(position = {}, currentPrice = null) {
  const entry =
    toNumber(position.entryPrice ?? position.price ?? position.openPrice ?? 0) ??
    0;
  const qty =
    toNumber(
      position.qty ??
        position.quantity ??
        position.amount ??
        position.positionSize ??
        0
    ) ?? 0;
  const side = normalizeSide(
    position.side || position.direction || position.positionSide
  );

  const px = toNumber(currentPrice ?? position.currentPrice ?? entry) ?? entry;
  const sign = side === "SELL" ? -1 : 1;

  return (px - entry) * qty * sign;
}

function annotatePosition(position = {}) {
  const currentPrice =
    toNumber(
      position.currentPrice ??
        getCurrentPriceForSymbol(position.symbol) ??
        position.price ??
        position.entryPrice ??
        0
    ) ?? 0;

  const entryPrice =
    toNumber(position.entryPrice ?? position.price ?? position.openPrice ?? 0) ??
    0;

  const qty =
    toNumber(
      position.qty ??
        position.quantity ??
        position.amount ??
        position.positionSize ??
        0
    ) ?? 0;

  const pnl = isClosedPosition(position)
    ? toNumber(position.realizedPnl ?? position.pnl ?? 0) ?? 0
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

async function getWalletDocForUser(userId) {
  try {
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
  } catch {
    return null;
  }
}

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
    const payload = {
      user: user?._id || user?.user || user?.id || null,
      userId: String(user?._id || user?.user || user?.id || ""),
      type,
      amount: Number(amount) || 0,
      status,
      note,
      balanceBefore: Number(balanceBefore) || 0,
      balanceAfter: Number(balanceAfter) || 0,
      meta,
      source,
      createdAt: new Date(),
    };

    const tx = await Transaction.create(payload);
    return tx.toObject ? tx.toObject() : tx;
  } catch (err) {
    console.warn("recordTransaction fallback:", err?.message || err);
    return {
      userId: String(user?._id || user?.user || user?.id || ""),
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

function normalizeWalletSnapshot(wallet, openPnl = 0) {
  const balanceOwn = toNumber(wallet?.balanceOwn ?? wallet?.balance ?? 0) ?? 0;
  const credit = toNumber(wallet?.credit ?? 0) ?? 0;
  const marginUsed = Math.max(toNumber(wallet?.marginUsed ?? 0) ?? 0, 0);
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
    marginLevel,
    leverageFactor: toNumber(wallet?.leverageFactor ?? 1) ?? 1,
    currency: wallet?.currency || "USD",
    openPnl,
  };
}

async function loadTransactionsForUser(userId, limit = 50) {
  try {
    const rows = await Transaction.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec()
      .catch(() => []);

    return rows || [];
  } catch {
    return [];
  }
}

async function loadAllTransactions(limit = 200, userId = null) {
  try {
    const query = userId ? { user: userId } : {};
    const rows = await Transaction.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec()
      .catch(() => []);
    return rows || [];
  } catch {
    return [];
  }
}

async function loadOpenPositionsForUser(userId) {
  try {
    const rows = await Position.find({
      user: userId,
      status: { $in: ["OPEN", "open", "Open"] },
    })
      .sort({ createdAt: -1 })
      .lean()
      .exec()
      .catch(() => []);

    return (rows || []).map(annotatePosition);
  } catch {
    return [];
  }
}

async function loadAllPositionsForUser(userId) {
  try {
    const rows = await Position.find({ user: userId })
      .sort({ createdAt: -1 })
      .lean()
      .exec()
      .catch(() => []);
    return (rows || []).map(annotatePosition);
  } catch {
    return [];
  }
}

async function buildAccountForUser(userDoc) {
  const wallet = await getWalletDocForUser(userDoc._id);
  const openPositions = await loadOpenPositionsForUser(userDoc._id);
  const recentTransactions = await loadTransactionsForUser(userDoc._id, 20);

  const openPnl = openPositions.reduce(
    (sum, p) => sum + (toNumber(p.pnl ?? 0) || 0),
    0
  );

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
    io.emit("wallet_update", {
      userId,
      account: accountPayload?.account || accountPayload,
    });
    io.emit("account_update", {
      userId,
      account: accountPayload?.account || accountPayload,
    });
    if (Array.isArray(positions)) {
      io.emit("positions_update", { userId, positions });
    }
    if (transaction) {
      io.emit("transactions_update", { userId, transaction });
    }
  } catch (e) {
    console.warn("emitStateUpdates error:", e?.message || e);
  }
}

async function getUserFromBearer(req) {
  try {
    const auth = req.headers.authorization || req.headers.Authorization || null;
    if (!auth || !auth.toLowerCase().startsWith("bearer ")) return null;

    const token = String(auth).split(" ")[1];
    if (!token) return null;
    if (!process.env.JWT_SECRET) return null;

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      return null;
    }

    const userId =
      payload && (payload.id || payload.sub || payload.userId || payload._id);
    if (!userId) return null;

    const user = await User.findById(userId).lean().exec().catch(() => null);
    return user || null;
  } catch (e) {
    return null;
  }
}

async function getPositionsForUser(userId) {
  try {
    return await Position.find({ user: userId }).lean().exec().catch(() => []);
  } catch {
    return [];
  }
}

async function getWalletForUser(userId) {
  try {
    return await Wallet.findOne({ user: userId }).lean().exec().catch(() => null);
  } catch {
    return null;
  }
}

/**
 * ======================================================
 * FUNCIÓN: VALIDAR MARGEN Y PERMITIR APERTURA
 * - Verifica si el usuario tiene saldo suficiente (freeMargin)
 * - Calcula margen requerido según precio, qty y leverage
 * - Si NO tiene saldo → devuelve error con mensaje flotante (toast)
 * - Si tiene saldo → devuelve ok=true para permitir abrir la posición
 * ======================================================
 */
async function validateMarginAndNotify({
  user,
  symbol,
  qty,
  entryPrice,
  leverage,
}) {
  try {
    const wallet = await getWalletDocForUser(user._id);

    const balanceOwn =
      toNumber(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) ?? 0;
    const credit = toNumber(wallet.credit ?? 0) ?? 0;
    const marginUsed = toNumber(wallet.marginUsed ?? 0) ?? 0;

    const freeMargin = balanceOwn + credit - marginUsed;
    const notional = Math.abs(qty * entryPrice);
    const requiredMargin = notional / Math.max(leverage || 1, 1);

    const marginLevel = marginUsed > 0 ? (balanceOwn / marginUsed) * 100 : 100;

    if (freeMargin < requiredMargin) {
      return {
        ok: false,
        error: "insufficient_margin",
        toast: {
          type: "error",
          title: "Fondos insuficientes",
          message: "No tienes margen suficiente para abrir esta operación.",
          details: {
            balance: balanceOwn,
            freeMargin,
            requiredMargin,
            marginLevel: Number(marginLevel.toFixed(2)),
          },
          closable: true,
          position: "top-right",
          duration: 5000,
          health:
            marginLevel < 50 ? "Cuenta en riesgo ⚠️" : "Margen insuficiente",
        },
      };
    }

    return {
      ok: true,
      data: {
        freeMargin,
        requiredMargin,
        marginLevel: Number(marginLevel.toFixed(2)),
      },
      toast: {
        type: "success",
        title: "Operación permitida",
        message: "La posición puede abrirse correctamente",
        closable: true,
        position: "top-right",
        duration: 3000,
      },
    };
  } catch (err) {
    console.error("validateMarginAndNotify error:", err);

    return {
      ok: false,
      error: "validation_error",
      toast: {
        type: "error",
        title: "Error",
        message: "No se pudo validar el margen",
        closable: true,
        position: "top-right",
      },
    };
  }
}







/**
 * ======================================================
 * FUNCIÓN: CERRAR OPERACIÓN
 * ======================================================
 */
async function tradeCloseHandler(req, res) {
  try {
    const user = await getUserFromBearer(req);
    if (!user) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const body = req.body || {};
    const positionId = body.positionId || body.id || body._id || body.tradeId || null;
    const symbol = String(body.symbol || "").trim().toUpperCase();

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
      return res.status(404).json({
        ok: false,
        error: "position_not_found",
        message: "Posición no encontrada",
      });
    }

    const currentPriceRaw =
      body.currentPrice ??
      getCurrentPriceForSymbol(position.symbol) ??
      position.currentPrice ??
      position.entryPrice ??
      0;

    const currentPrice = toNumber(currentPriceRaw) ?? 0;
    const entryPrice =
      toNumber(position.entryPrice ?? position.price ?? position.openPrice ?? 0) ??
      0;
    const qty =
      toNumber(position.qty ?? position.quantity ?? position.amount ?? 0) ?? 0;

    const side = normalizeSide(position.side || position.direction);
    const sign = side === "SELL" ? -1 : 1;

    const realizedPnl = (currentPrice - entryPrice) * qty * sign;

    const wallet = await getWalletDocForUser(user._id);

    const balanceBefore =
      toNumber(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) ?? 0;
    const reservedMargin = toNumber(position.marginReserved ?? 0) ?? 0;

    wallet.marginUsed = Math.max((toNumber(wallet.marginUsed ?? 0) ?? 0) - reservedMargin, 0);
    wallet.balanceOwn = balanceBefore + realizedPnl;
    wallet.balance = wallet.balanceOwn;
    wallet.updatedAt = new Date();
    await wallet.save();

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
    const annotatedPosition = annotatePosition(
      position.toObject ? position.toObject() : position
    );

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
    console.error("tradeCloseHandler error:", err);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message || "Error interno",
    });
  }
}

async function tradeCloseAllHandler(req, res) {
  try {
    const user = await getUserFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const openPositions = await Position.find({
      user: user._id,
      status: { $in: ["OPEN", "open", "Open"] },
    })
      .sort({ createdAt: -1 })
      .catch(() => []);

    if (!openPositions.length) {
      return res.json({
        ok: true,
        msg: "No hay posiciones abiertas",
        closed: 0,
        totalRealized: 0,
      });
    }

    let totalRealized = 0;
    const closed = [];

    for (const pos of openPositions) {
      const currentPrice =
        toNumber(
          req.body?.currentPrice ??
            getCurrentPriceForSymbol(pos.symbol) ??
            pos.currentPrice ??
            pos.entryPrice ??
            0
        ) ?? 0;

      const entryPrice =
        toNumber(pos.entryPrice ?? pos.price ?? pos.openPrice ?? 0) ?? 0;
      const qty = toNumber(pos.qty ?? pos.quantity ?? pos.amount ?? 0) ?? 0;
      const side = normalizeSide(pos.side || pos.direction);
      const sign = side === "SELL" ? -1 : 1;
      const realizedPnl = (currentPrice - entryPrice) * qty * sign;

      const wallet = await getWalletDocForUser(user._id);
      const balanceBefore =
        toNumber(wallet.balanceOwn ?? wallet.balance ?? user.balance ?? 0) ?? 0;
      const reservedMargin = toNumber(pos.marginReserved ?? 0) ?? 0;

      wallet.marginUsed = Math.max(
        (toNumber(wallet.marginUsed ?? 0) ?? 0) - reservedMargin,
        0
      );
      wallet.balanceOwn = balanceBefore + realizedPnl;
      wallet.balance = wallet.balanceOwn;
      wallet.equity = wallet.balanceOwn;
      wallet.freeMargin = Math.max(wallet.equity - wallet.marginUsed, 0);
      wallet.marginLevel =
        wallet.marginUsed > 0 ? (wallet.equity / wallet.marginUsed) * 100 : 0;
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
      data: {
        closed,
        totalRealized,
        account: account.account,
        wallet: account.wallet,
      },
    });
  } catch (err) {
    console.error("/api/trade/close-all error:", err);
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: err?.message || "Error interno",
    });
  }
}

/* ======================================================
   API ROUTES - montamos rutas principales
   ====================================================== */
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/verification", verificationRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/positions", positionsRoutes);
app.use("/api/trade", tradeRoutes);
app.use("/api/account", accountRoutes);

/* ======================================================
   SAMPLE SYMBOLS / FALLBACK
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
  return {
    ok: true,
    count: quotes.length,
    quotes,
    data: quotes,
    items: quotes,
    latest: quotes[0] || null,
    symbols: quotes.map((q) => ({
      symbol: q.symbol,
      label: q.label,
      market: q.market,
    })),
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

/* ======================================================
   SOCKET.IO + PRICE HANDLER
   ====================================================== */
const httpServer = createServer(app);

const io = new IOServer(httpServer, {
  cors: {
    origin:
      Array.from(allowedOrigins).length
        ? Array.from(allowedOrigins)
        : process.env.CLIENT_URL || "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const priceHandler = new PriceHandler(io);

/* ======================================================
   POLYGON SOCKET (realtime provider)
   ====================================================== */
let polygonSocket = null;
try {
  if (!process.env.POLYGON_API_KEY) {
    console.warn(
      "⚠️ POLYGON_API_KEY no definido — realtime de mercado no podrá conectarse"
    );
  } else {
    try {
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
          maybe.catch((err) => {
            console.warn("PolygonSocket.connect() rejected:", err);
            polygonSocket = null;
          });
        }
        console.log("🔌 Intentando conectar PolygonSocket...");
      } catch (err) {
        console.error("Error iniciando PolygonSocket.connect():", err);
        polygonSocket = null;
      }
    } catch (err) {
      console.error("Error inicializando PolygonSocket instance:", err);
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
   Fallbacks para eliminar 404 en rutas que tu frontend está llamando
   ====================================================== */
app.get("/api/quotes", (req, res) => {
  const payload = buildMarketPayload();
  return res.json(payload.quotes);
});

app.get("/api/latest", (req, res) => {
  const payload = buildMarketPayload();
  return res.json(payload.latest || {});
});

app.get("/api/market/quotes", (req, res) => {
  return res.json(buildMarketPayload());
});

app.get("/api/market/latest", (req, res) => {
  const payload = buildMarketPayload();
  return res.json(payload.latest || {});
});

app.get("/api/market/polygon/quotes", (req, res) => {
  return res.json(buildMarketPayload());
});

app.get("/api/market/polygon/symbols", (req, res) => {
  return res.json(SAMPLE_SYMBOLS);
});

app.get("/api/symbols", (req, res) => {
  try {
    const prices = getPriceStore();
    if (prices && Object.keys(prices).length) {
      const arr = Object.keys(prices).map((k) => {
        return {
          symbol: k,
          label: (k.split(":").pop() || k).replace("_", "/"),
          market: prices[k] && prices[k].market ? prices[k].market : "Unknown",
        };
      });
      return res.json(arr);
    }
    return res.json(SAMPLE_SYMBOLS);
  } catch (err) {
    console.error("api/symbols error:", err);
    return res.json(SAMPLE_SYMBOLS);
  }
});

/* ======================================================
   Compat endpoints: /api/account, /api/me, /api/profile
   ====================================================== */
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

app.get("/api/account", accountLikeHandler);
app.get("/api/me", accountLikeHandler);
app.get("/api/profile", accountLikeHandler);
app.get("/api/cuenta", (req, res) => {
  return res.redirect(307, "/api/account");
});

async function positionsLikeHandler(req, res) {
  try {
    const user = await getUserFromBearer(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const positions = await loadOpenPositionsForUser(user._id);
    return res.json({
      ok: true,
      positions,
      data: positions,
      items: positions,
      count: positions.length,
    });
  } catch (e) {
    console.error("positionsLikeHandler error", e);
    return res.status(500).json({ error: "Server error" });
  }
}

app.get("/api/positions", positionsLikeHandler);
app.get("/api/trade/positions", positionsLikeHandler);

app.get("/api/wallet", async (req, res) => {
  try {
    const user = await getUserFromBearer(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const wallet = await getWalletForUser(user._id);
    if (wallet) return res.json(wallet);

    return res.json({
      balance: user.balance ?? 0,
      currency: user.currency || "USD",
    });
  } catch (e) {
    console.error("/api/wallet error", e);
    return res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/billetera", (req, res) => {
  return res.redirect(307, "/api/wallet");
});

/* ======================================================
   Redirección para /api/api/* -> /api/* (si frontend duplica prefijo)
   ====================================================== */
app.use("/api/api", (req, res) => {
  const newUrl = req.originalUrl.replace(/^\/api\/api/, "/api");
  return res.redirect(307, newUrl);
});

/* ======================================================
   SOCKET.IO EVENTS
   ====================================================== */
io.on("connection", (socket) => {
  console.log("📡 Cliente conectado:", socket.id);

  try {
    socket.emit("prices_snapshot", getPriceStore() || {});
  } catch (e) {
    socket.emit("prices_snapshot", {});
  }

  socket.on("request_prices_snapshot", () => {
    try {
      socket.emit("prices_snapshot", getPriceStore() || {});
    } catch (e) {
      socket.emit("prices_snapshot", {});
    }
  });

  socket.on("request_symbols", () => {
    try {
      const prices = getPriceStore();
      if (priceHandler && typeof priceHandler.getSymbols === "function") {
        const syms = priceHandler.getSymbols();
        socket.emit("symbols_update", syms || []);
      } else if (prices && Object.keys(prices).length) {
        const arr = Object.keys(prices).map((k) => ({
          symbol: k,
          label: (k.split(":").pop() || k).replace("_", "/"),
          market:
            prices[k] && prices[k].market ? prices[k].market : "Unknown",
        }));
        socket.emit("symbols_update", arr);
      } else {
        socket.emit("symbols_update", SAMPLE_SYMBOLS);
      }
    } catch (e) {
      socket.emit("symbols_update", SAMPLE_SYMBOLS);
    }
  });

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

  socket.on("disconnect", (reason) => {
    console.log("❌ Cliente desconectado:", socket.id, "reason:", reason);
  });
});

/* ======================================================
   STATIC FRONTEND
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
  } catch (e) {}
}

if (!staticDirName) {
  staticDirName = "public";
  console.warn(
    `WARN: No se encontró carpeta estática entre ${staticCandidates.join(
      ", "
    )}. Usando fallback '${staticDirName}'. Asegúrate de que exista la carpeta con los assets (index.html).`
  );
} else {
  console.log(`Static folder detected: '${staticDirName}'`);
}

const staticPath = path.join(__dirname, staticDirName);
const jsDirPath = path.join(staticPath, "js");

/* ======================================================
   RESOLUCIÓN ROBUSTA DE ARCHIVOS JS
   ====================================================== */
function stripScriptWrappers(source) {
  let text = String(source ?? "");

  text = text.replace(/^\uFEFF/, "");

  const trimmed = text.trim();

  const startsWithScript = /^<script\b[^>]*>/i.test(trimmed);
  const endsWithScript = /<\/script>\s*$/i.test(trimmed);

  if (startsWithScript && endsWithScript) {
    text = trimmed
      .replace(/^<script\b[^>]*>/i, "")
      .replace(/<\/script>\s*$/i, "");
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

      res
        .status(200)
        .type("application/javascript; charset=utf-8")
        .send(cleaned);
      return;
    }

    res
      .status(404)
      .type("application/javascript; charset=utf-8")
      .send(`
// JS missing: ${pathname}
console.error("JS missing: ${pathname}");

window.CATEGORIES = window.CATEGORIES || [];
window.SESSION_KEY = window.SESSION_KEY || "BROKERPRO_SESSION_USER";
window.API = window.API || "/api";
window.SOCKET_URL = window.SOCKET_URL || location.origin;
window._LEONES = window._LEONES || {};
window._LEONES_TRADING = window._LEONES_TRADING || {};
window._LEONES_TRADING.fetchPositions =
  window._LEONES_TRADING.fetchPositions ||
  (async function () { return []; });

if (!window.loadPositions) {
  window.loadPositions = async function () {
    try {
      if (
        window._LEONES_TRADING &&
        typeof window._LEONES_TRADING.fetchPositions === "function"
      ) {
        return await window._LEONES_TRADING.fetchPositions();
      }
    } catch (e) {
      console.warn("loadPositions stub error", e);
    }
    return null;
  };
}

if (!window.loadRealQuotes) {
  window.loadRealQuotes = async function () {
    return null;
  };
}
`);
  } catch (err) {
    console.error("Error sirviendo JS:", err);
    res.status(500).type("application/javascript; charset=utf-8").send(`console.error("JS server error");`);
  }
});

/* ======================================================
   STATIC FILES
   ====================================================== */
app.use("/public", express.static(staticPath));
app.use("/js", express.static(jsDirPath));
app.use(express.static(staticPath));

/* ======================================================
   Fallback HTML
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

/* ======================================================
   404 API
   ====================================================== */
app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found" });
});

/* ======================================================
   ERROR HANDLER
   ====================================================== */
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({
    error: "Server error",
    message: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
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

  if (!process.env.POLYGON_API_KEY) {
    console.warn("⚠️ POLYGON_API_KEY no configurado — realtime limitado");
  }
  if (!process.env.RESEND_API_KEY) {
    console.warn("⚠️ Resend no configurado — emails pueden usar SMTP o simulación");
  }
});

/* ======================================================
   GRACEFUL SHUTDOWN
   ====================================================== */
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
        console.log("HTTP cerrado");
        resolve();
      });
    });

    try {
      await safeClosePolygonSocket();
    } catch (e) {
      console.warn("Error cerrando polygonSocket (await):", e);
    }

    try {
      if (typeof global?.stopRiskWatcher === "function") {
        try {
          global.stopRiskWatcher();
        } catch (e) {
          console.warn("stopRiskWatcher threw:", e);
        }
      }
    } catch (e) {
      console.warn("Error deteniendo risk watcher:", e);
    }

    try {
      await mongoose.disconnect();
      console.log("Mongo cerrado");
    } catch (e) {
      console.warn("Error desconectando Mongo:", e);
    }

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
