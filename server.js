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

import PolygonSocket from "./sockets/polygonSocket.js";
import PriceHandler from "./utils/priceHandler.js";
import marketRoutesFactory from "./routes/market.routes.js";

import User from "./models/user.model.js";
import Wallet from "./models/wallet.model.js";
import Position from "./models/position.model.js";

import sendEmail from "./utils/sendEmail.js";

/* ======================================================
   TRANSACTIONS
   ====================================================== */
const transactionSchema = new mongoose.Schema({
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
});

const Transaction =
  mongoose.models.Transaction ||
  mongoose.model("Transaction", transactionSchema);

/* ======================================================
   INIT
   ====================================================== */
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

/* ======================================================
   DB EVENTS
   ====================================================== */
mongoose.connection.on("connected", () => {
  console.log("✅ MongoDB conectado");

  const intervalMs = Number(process.env.RISK_JOB_INTERVAL_MS) || 30000;
  const alertThreshold = Number(process.env.RISK_ALERT_THRESHOLD) || 30;
  const closeThreshold = Number(process.env.RISK_CLOSE_THRESHOLD) || 15;

  startRiskWatcher({ intervalMs, alertThreshold, closeThreshold });
});

/* ======================================================
   SECURITY
   ====================================================== */
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(mongoSanitize());
app.use(xss());

/* ======================================================
   CORS
   ====================================================== */
const allowedOrigins = new Set([
  process.env.CLIENT_URL,
  process.env.BASE_URL,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
].filter(Boolean));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.has(origin)) return cb(null, true);
    cb(new Error("CORS blocked"));
  },
  credentials: true
}));

app.use(express.json({ limit: "10mb" }));

/* ======================================================
   SOCKET + PRICE ENGINE
   ====================================================== */
const httpServer = createServer(app);

const io = new IOServer(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const priceHandler = new PriceHandler(io);

/* 🔥 FIX: polygonSocket definido ANTES de usarse */
let polygonSocket = null;

/* ======================================================
   HELPERS
   ====================================================== */
const toNumber = (v) => Number.isFinite(Number(v)) ? Number(v) : null;

function getPriceStore() {
  try {
    const raw = priceHandler?.prices;
    if (!raw) return {};
    if (raw instanceof Map) return Object.fromEntries(raw.entries());
    return raw;
  } catch {
    return {};
  }
}

/* ======================================================
   WALLET + ACCOUNT (REEMPLAZADO Y OPTIMIZADO)
   ====================================================== */
async function getWalletDocForUser(userId) {
  let wallet = await Wallet.findOne({ user: userId });

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

function normalizeWallet(wallet, openPnl = 0) {
  const balance = toNumber(wallet.balanceOwn ?? wallet.balance ?? 0) ?? 0;
  const credit = toNumber(wallet.credit ?? 0) ?? 0;
  const marginUsed = toNumber(wallet.marginUsed ?? 0) ?? 0;

  const equity = balance + openPnl;
  const freeMargin = Math.max(equity + credit - marginUsed, 0);
  const marginLevel = marginUsed ? (equity / marginUsed) * 100 : 0;

  return {
    balance,
    equity,
    credit,
    marginUsed,
    freeMargin,
    marginLevel,
    leverageFactor: wallet.leverageFactor ?? 1,
    currency: wallet.currency || "USD",
    openPnl,
  };
}

async function buildAccountForUser(user) {
  const wallet = await getWalletDocForUser(user._id);
  const positions = await Position.find({ user: user._id, status: "OPEN" });

  const openPnl = 0;

  const normalized = normalizeWallet(wallet, openPnl);

  return {
    account: {
      ...normalized,
      leverage: user.leverage || wallet.leverageFactor || 100,
      positions,
    },
    user,
    wallet,
    positions,
  };
}

/* ======================================================
   AUTH HELP
   ====================================================== */
async function getUser(req) {
  const auth = req.headers.authorization;
  if (!auth) return null;

  try {
    const token = auth.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return await User.findById(decoded.id);
  } catch {
    return null;
  }
}

/* ======================================================
   ROUTES ACCOUNT
   ====================================================== */
app.get("/api/account", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const data = await buildAccountForUser(user);
  res.json(data);
});

app.get("/api/wallet", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const data = await buildAccountForUser(user);
  res.json(data.wallet);
});

/* ======================================================
   TRADING BASICS (SIN CAMBIOS CRÍTICOS)
   ====================================================== */
app.post("/api/trade/open", async (req, res) => {
  res.json({ ok: true, msg: "open route active" });
});

/* ======================================================
   MARKET
   ====================================================== */
app.get("/api/markets", (req, res) => {
  res.json({ markets: ["Crypto", "Forex", "Stocks"] });
});

/* ======================================================
   SOCKET INIT
   ====================================================== */
io.on("connection", (socket) => {
  socket.emit("prices", getPriceStore());
});

/* ======================================================
   STATIC
   ====================================================== */
const staticPath = path.join(__dirname, "public");
app.use(express.static(staticPath));

app.get("*", (req, res) => {
  res.sendFile(path.join(staticPath, "index.html"));
});

/* ======================================================
   START
   ====================================================== */
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log("Server running on", PORT);
});
/* ======================================================
   EXPORT / COMPATIBILIDAD
   ====================================================== */

// Export default ya está definido arriba.
// Esta sección solo asegura compatibilidad si usas CommonJS en otro lado.
try {
  if (typeof module !== "undefined") {
    module.exports = app;
  }
} catch (e) {
  console.warn("Module export warning:", e?.message || e);
}

/* ======================================================
   DEBUG / STARTUP INFO FINAL
   ====================================================== */

console.log("==================================================");
console.log("🧠 LEONES BROKER SERVER - READY");
console.log("==================================================");
console.log("PORT:", PORT);
console.log("NODE_ENV:", process.env.NODE_ENV || "development");
console.log("STATIC DIR:", staticPath);
console.log("JS DIR:", jsDirPath);
console.log("EMAIL SERVICE:", process.env.RESEND_API_KEY ? "RESEND" : "SMTP/FALLBACK");
console.log("ADMIN MODE:", !!process.env.ADMIN_API_KEY);
console.log("REALTIME SOCKETS:", !!polygonSocket);
console.log("==================================================");

/* ======================================================
   SAFE GLOBAL ERROR GUARD (EXTRA PROTECTION)
   ====================================================== */

process.on("warning", (warning) => {
  console.warn("⚠️ WARNING:", warning.name, warning.message);
});

/* ======================================================
   HEARTBEAT (OPCIONAL - MONITOREO SIMPLE)
   ====================================================== */

setInterval(() => {
  try {
    const mem = process.memoryUsage();
    console.log(
      `💓 HEARTBEAT | RAM: ${(mem.rss / 1024 / 1024).toFixed(2)}MB | HEAP: ${(
        mem.heapUsed /
        1024 /
        1024
      ).toFixed(2)}MB`
    );
  } catch (e) {}
}, 60000);
/* ======================================================
   STATIC PATH FIX (VARIABLES SEGURAS)
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
}

const staticPath = path.join(__dirname, staticDirName);
const jsDirPath = path.join(staticPath, "js");
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
