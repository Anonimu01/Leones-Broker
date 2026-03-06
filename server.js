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

import nodemailer from "nodemailer";
import jwt from "jsonwebtoken";

import { connectDB } from "./config/db.js";

import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import verificationRoutes from "./routes/verification.routes.js";
import walletRoutes from "./routes/wallet.routes.js";
import positionsRoutes from "./routes/positions.routes.js";
import tradeRoutes from "./routes/trade.routes.js";
import accountRoutes from "./routes/account.routes.js"; // agregado

import { startRiskWatcher } from "./jobs/risk.job.js";

// Realtime
import PolygonSocket from "./sockets/polygonSocket.js";
import PriceHandler from "./utils/priceHandler.js";
import marketRoutesFactory from "./routes/market.routes.js";

// Models (used for account/wallet endpoints fallback)
import User from "./models/user.model.js";
import Wallet from "./models/wallet.model.js";
import Position from "./models/position.model.js";

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
   - Helmet activo pero CSP desactivado para evitar bloqueos del frontend
   ====================================================== */
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(mongoSanitize());
app.use(xss());

/* ======================================================
   RATE LIMIT (basic)
   ====================================================== */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 200, // requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api", limiter);

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
    "https://leones-broker.onrender.com", // añadido por seguridad/compat
  ].filter(Boolean)
);

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    try {
      const url = new URL(origin);
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1")
        return callback(null, true);
    } catch (e) {}
    console.warn("CORS denied for origin:", origin);
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
};

app.use(cors(corsOptions));

/* ======================================================
   BASIC MIDDLEWARES
   ====================================================== */

// logger
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} › ${req.method} ${req.originalUrl}`);
  next();
});

// body parsers
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

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
   SEND EMAIL HELPER (Resend API fallback to SMTP)
   ====================================================== */

/**
 * sendViaResend: use global fetch if available, otherwise dynamic-import node-fetch
 */
async function sendViaResend(from, to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY no configurado");

  const body = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject: subject || "(no subject)",
    html: html || "",
  };

  // ensure fetch exists (node 18+ has global fetch; otherwise try node-fetch)
  let fetchFn = globalThis.fetch;
  if (!fetchFn) {
    try {
      // dynamic import to avoid require issues in ESM
      const mod = await import("node-fetch");
      fetchFn = mod.default || mod;
    } catch (e) {
      throw new Error("fetch no disponible en el runtime y node-fetch no pudo importarse");
    }
  }

  const resp = await fetchFn("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => null);
    const err = new Error(`Resend error ${resp.status}: ${txt || resp.statusText}`);
    err.status = resp.status;
    err.body = txt;
    throw err;
  }

  const json = await resp.json().catch(() => ({}));
  return json;
}

let smtpTransporter = null;
async function getSmtpTransporter() {
  if (smtpTransporter) return smtpTransporter;

  const host = process.env.MAIL_HOST;
  const port = Number(process.env.MAIL_PORT) || (process.env.MAIL_PORT ? Number(process.env.MAIL_PORT) : 465);
  const user = process.env.EMAIL_USER || process.env.SMTP_USER;
  const pass = process.env.EMAIL_PASS || process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error("SMTP no configurado (MAIL_HOST / EMAIL_USER / EMAIL_PASS faltantes)");
  }

  smtpTransporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465, false for other ports
    auth: { user, pass },
  });

  try {
    await smtpTransporter.verify();
    console.log("SMTP transporter verificado");
  } catch (e) {
    console.warn("Warn: SMTP verify falló:", e && e.message ? e.message : e);
  }

  return smtpTransporter;
}

async function sendViaSmtp(from, to, subject, html) {
  const transporter = await getSmtpTransporter();
  const info = await transporter.sendMail({
    from,
    to,
    subject,
    html,
  });
  return info;
}

async function sendEmail(to, subject, html, opts = {}) {
  const from = opts.from || process.env.SENDER_EMAIL || process.env.EMAIL_USER || `no-reply@${process.env.BASE_URL?.replace(/^https?:\/\//, "") || "localhost"}`;

  if (process.env.RESEND_API_KEY) {
    try {
      const r = await sendViaResend(from, to, subject, html);
      return { ok: true, provider: "resend", result: r };
    } catch (e) {
      console.error("Resend send failed:", e && e.message ? e.message : e);
    }
  }

  try {
    const info = await sendViaSmtp(from, to, subject, html);
    return { ok: true, provider: "smtp", result: info };
  } catch (e) {
    console.error("SMTP send failed:", e && e.message ? e.message : e);
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

app.locals.sendEmail = sendEmail;

app.post("/api/_send_test_email", async (req, res) => {
  const to = (req.body && req.body.to) || process.env.SENDER_EMAIL;
  if (!to) return res.status(400).json({ ok: false, message: "Necesitas enviar 'to' en el body o configurar SENDER_EMAIL" });

  const subject = req.body.subject || "Prueba de correo - Leones Broker";
  const html = req.body.html || `<p>Esto es una prueba desde el servidor de Leones Broker. Si recibes este correo, Resend/SMTP está funcionando.</p>`;

  try {
    const r = await sendEmail(to, subject, html);
    if (r.ok) return res.json({ ok: true, message: "Correo enviado", provider: r.provider, result: r.result });
    return res.status(500).json({ ok: false, message: "No se pudo enviar correo", error: r.error });
  } catch (err) {
    console.error("test email error:", err);
    return res.status(500).json({ ok: false, message: "Error interno enviando correo", error: err && err.message ? err.message : String(err) });
  }
});

/* ======================================================
   API ROUTES - montamos rutas principales (ingles)
   ====================================================== */
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/verification", verificationRoutes);
app.use("/api/wallet", walletRoutes);
// positions + trade routes: montamos en inglés y también alias en español más abajo
app.use("/api/positions", positionsRoutes);
app.use("/api/trade", tradeRoutes);
app.use("/api/account", accountRoutes); // agregado

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

app.get("/api/markets", (req, res) =>
  res.json({ markets: ["Crypto", "Stocks", "Forex", "Indices", "Futures", "Bonds"] })
);
app.get("/api/market/list", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/market/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/markets/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/api/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/api/markets", (req, res) => res.json({ markets: ["Crypto", "Stocks", "Forex", "Indices"] }));

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
      polygonSocket.connect();
      console.log("🔌 Intentando conectar PolygonSocket...");
    } catch (err) {
      console.error("Error iniciando PolygonSocket.connect():", err);
    }
  }
} catch (err) {
  console.error("Error inicializando PolygonSocket:", err);
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
   /api/symbols endpoint dinámico
   ====================================================== */
app.get("/api/symbols", (req, res) => {
  try {
    const prices = priceHandler && priceHandler.prices ? priceHandler.prices : null;
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
   SOCKET.IO EVENTS
   ====================================================== */
io.on("connection", (socket) => {
  console.log("📡 Cliente conectado:", socket.id);

  try {
    socket.emit("prices_snapshot", priceHandler.prices || {});
  } catch (e) {
    socket.emit("prices_snapshot", {});
  }

  socket.on("request_prices_snapshot", () => {
    try {
      socket.emit("prices_snapshot", priceHandler.prices || {});
    } catch (e) {
      socket.emit("prices_snapshot", {});
    }
  });

  socket.on("request_symbols", () => {
    try {
      if (priceHandler && typeof priceHandler.getSymbols === "function") {
        const syms = priceHandler.getSymbols();
        socket.emit("symbols_update", syms || []);
      } else if (priceHandler && priceHandler.prices) {
        const arr = Object.keys(priceHandler.prices).map((k) => ({
          symbol: k,
          label: (k.split(":").pop() || k).replace("_", "/"),
          market:
            priceHandler.prices[k] && priceHandler.prices[k].market
              ? priceHandler.prices[k].market
              : "Unknown",
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
      if (polygonSocket && typeof polygonSocket.subscribe === "function")
        polygonSocket.subscribe(symbol, kind);
      socket.join(symbol);
      console.log("subscribe:", socket.id, symbol, kind || "trades");
    } catch (e) {
      console.warn("subscribe error:", e);
    }
  });

  socket.on("unsubscribe", ({ symbol, kind } = {}) => {
    if (!symbol) return;
    try {
      if (polygonSocket && typeof polygonSocket.unsubscribe === "function")
        polygonSocket.unsubscribe(symbol, kind);
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
   Helper: obtener usuario desde token (si aplica)
   ====================================================== */
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
    const userId = payload && (payload.id || payload.sub || payload.userId || payload._id);
    if (!userId) return null;
    const user = await User.findById(userId).lean().exec().catch(()=>null);
    return user || null;
  } catch (e) {
    return null;
  }
}

/* ======================================================
   Redirección para /api/api/* -> /api/* (si frontend duplica prefijo)
   ====================================================== */
app.use("/api/api", (req, res) => {
  // Redirigir al mismo path sin duplicar /api
  const newUrl = req.originalUrl.replace(/^\/api\/api/, "/api");
  return res.redirect(307, newUrl);
});

/* ======================================================
   Compat endpoints: /api/account  y /api/wallet (añado alias en español)
   ====================================================== */
app.get("/api/account", async (req, res) => {
  try {
    const user = await getUserFromBearer(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    let wallet = null;
    try {
      wallet = await Wallet.findOne({ user: user._1d }).lean().exec().catch(()=>null);
    } catch (e) { wallet = null; }
    let positions = [];
    try {
      positions = await Position.find({ user: user._id }).lean().exec().catch(()=>[]);
    } catch (e) { positions = []; }

    const account = {
      balance: wallet?.balance ?? user.balance ?? 0,
      equity: wallet?.balance ?? user.balance ?? 0,
      marginUsed: 0,
      freeMargin: wallet?.balance ?? user.balance ?? 0,
      marginLevel: 0,
      leverage: user.leverage ?? 100,
      currency: user.currency || "USD",
      positions: positions || [],
    };
    return res.json({ account });
  } catch (e) {
    console.error("/api/account error", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// alias español /api/cuenta -> redirige a /api/account
app.get("/api/cuenta", (req, res) => {
  return res.redirect(307, "/api/account");
});

app.get("/api/wallet", async (req, res) => {
  try {
    const user = await getUserFromBearer(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    let wallet = null;
    try {
      wallet = await Wallet.findOne({ user: user._id }).lean().exec().catch(()=>null);
    } catch (e) { wallet = null; }

    if (wallet) return res.json(wallet);
    return res.json({ balance: user.balance ?? 0, currency: user.currency || "USD" });
  } catch (e) {
    console.error("/api/wallet error", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// alias español /api/billetera -> redirige a /api/wallet
app.get("/api/billetera", (req, res) => {
  return res.redirect(307, "/api/wallet");
});

/* ======================================================
   404 API (único fallback para /api)
   ====================================================== */
app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found" });
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

/* ======================================================
   JS STUBS middleware (evita MIME error / ReferenceError)
   - ahora soporta /js/* para evitar que index.html sea servido como JS cuando faltan assets
   ====================================================== */
app.get(["/js/main.js", "/js/trading.js", "/js/*"], (req, res, next) => {
  try {
    // resolvemos sin querystring: Express ya separa query, req.path no incluye ?
    const requestedPath = path.join(staticPath, req.path);
    if (fs.existsSync(requestedPath) && fs.statSync(requestedPath).isFile()) {
      return next(); // si existe, que lo sirva express.static
    }
  } catch (e) {}

  const stub = `
/* Auto-generated JS stub — served because ${req.path} not present on disk.
   This prevents MIME errors and provides safe placeholders for globals. */
window.CATEGORIES = window.CATEGORIES || [];
window.SESSION_KEY = window.SESSION_KEY || "BROKERPRO_SESSION_USER";
window.API = window.API || "/api";
window.SOCKET_URL = window.SOCKET_URL || location.origin;
window._LEONES = window._LEONES || {};
if (!window.loadPositions) {
  window.loadPositions = async function() {
    try {
      if (window._LEONES_TRADING && typeof window._LEONES_TRADING.fetchPositions === "function") {
        return await window._LEONES_TRADING.fetchPositions();
      }
    } catch (e) { console.warn('loadPositions stub error', e); }
    return null;
  };
}
console.log("Served JS stub for ${req.path}");
`;

  res.type("application/javascript; charset=utf-8").status(200).send(stub);
});

app.use(express.static(staticPath));

app.get("*", (req, res) => {
  // evitar servir index.html para rutas de API
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
   ERROR HANDLER
   ====================================================== */
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  // En producción no mandamos detalles
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

  if (!process.env.POLYGON_API_KEY)
    console.warn("⚠️ POLYGON_API_KEY no configurado — realtime limitado");
  if (!process.env.RESEND_API_KEY)
    console.warn("⚠️ Resend no configurado — emails pueden usar SMTP o simulación");
});

/* ======================================================
   GRACEFUL SHUTDOWN
   ====================================================== */
let shuttingDown = false;

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
      if (polygonSocket && typeof polygonSocket.close === "function") {
        polygonSocket.close();
      }
    } catch (e) {
      console.warn("Error cerrando polygonSocket:", e);
    }

    try {
      if (typeof global?.stopRiskWatcher === "function") {
        global.stopRiskWatcher();
      }
    } catch (e) {
      console.warn("Error deteniendo risk watcher:", e);
    }

    await mongoose.disconnect();
    console.log("Mongo cerrado");

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
  gracefulShutdown("unhandledRejection");
});
process.on("uncaughtException", (e) => {
  console.error("UncaughtException:", e);
  gracefulShutdown("uncaughtException");
});

export default app;
