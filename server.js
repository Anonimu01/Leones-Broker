// server.js (CSP configurado + seguridad + comentarios)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { createServer } from "http";
import { Server as IOServer } from "socket.io";

import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import mongoSanitize from "express-mongo-sanitize";
import xss from "xss-clean";

import { connectDB } from "./config/db.js";

import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import verificationRoutes from "./routes/verification.routes.js";
import walletRoutes from "./routes/wallet.routes.js";
import positionsRoutes from "./routes/positions.routes.js";
import tradeRoutes from "./routes/trade.routes.js";

import { startRiskWatcher } from "./jobs/risk.job.js";

// Realtime
import PolygonSocket from "./sockets/polygonSocket.js";
import PriceHandler from "./utils/priceHandler.js";
import marketRoutesFactory from "./routes/market.routes.js";

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
   SECURITY MIDDLEWARES (helmet, compression, sanitize, etc)
   ====================================================== */

/*
  Nota: Helmet por defecto aplica varias cabeceras.
  A continuación desactivamos la CSP por defecto y aplicamos
  una CSP personalizada que permite los CDNs que necesitas.

  - Si quieres máxima seguridad: NO uses 'unsafe-inline' y mueve
    los scripts inline a archivos externos (o implementa nonces).
  - Si necesitas que todo funcione ahora (botones, scripts inline),
    verás un bloque marcado // QUICK FIX que añade 'unsafe-inline'.
    **Quita ese bloque tan pronto como migrés los handlers inline.**
*/
app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  helmet.contentSecurityPolicy({
    useDefaults: false, // usamos directivas completas
    directives: {
      defaultSrc: ["'self'"],
      // Scripts permitidos: tu dominio + los CDNs que usas
      // Si quieres activar la solución rápida, ver la nota más abajo.
      scriptSrc: [
        "'self'",
        "https://unpkg.com",
        "https://s3.tradingview.com",
        "https://cdnjs.cloudflare.com",
      ],
      // Permite cargar scripts desde estos elementos también
      scriptSrcElem: [
        "'self'",
        "https://unpkg.com",
        "https://s3.tradingview.com",
        "https://cdnjs.cloudflare.com",
      ],
      // QUICK FIX: si tus botones usan onclick="" o tienes scripts inline en HTML,
      // descomenta la siguiente línea para permitirlos temporalmente.
      // ADVERTENCIA: esto reduce la protección contra XSS. Quita cuando migres.
      // scriptSrcAttr: ["'unsafe-inline'"],
      //
      // Styles: permitimos self + CDN y 'unsafe-inline' para estilos en línea (por now)
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      // Fonts & images
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://s3.tradingview.com"],
      // Conexiones (fetch / websocket)
      connectSrc: [
        "'self'",
        "wss:",
        "https://api.polygon.io",
        "https://leones-broker.onrender.com",
        "https://*.polygon.io",
      ],
      // bloques
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      upgradeInsecureRequests: [],
    },
  })
);

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
      : process.env.EMAIL_USER
      ? "smtp"
      : "none",
    db: mongoose.connection.name || null,
    adminApiKeyConfigured: !!process.env.ADMIN_API_KEY,
  });
});

/* ======================================================
   API ROUTES
   ====================================================== */
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/verification", verificationRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/positions", positionsRoutes);
app.use("/api/trade", tradeRoutes);

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
   POLYGON SOCKET
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
   404 API
   ====================================================== */
app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found" });
});

/* ======================================================
   STATIC FRONTEND
   NOTE: si prefieres inyectar nonces para scripts inline,
   deberíamos servir index.html leyendo el archivo y reemplazando
   los <script> que quieras con nonce="...". Te lo puedo armar.
   ====================================================== */
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
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

  if (!process.env.POLYGON_API_KEY)
    console.warn("⚠️ POLYGON_API_KEY no configurado — realtime limitado");
  if (!process.env.RESEND_API_KEY)
    console.warn("⚠️ Resend no configurado — emails pueden usar SMTP o simulación");
});

/* ======================================================
   GRACEFUL SHUTDOWN (igual que tenías)
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
