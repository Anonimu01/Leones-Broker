// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { createServer } from "http";
import { Server as IOServer } from "socket.io";

import { connectDB } from "./config/db.js";

import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import verificationRoutes from "./routes/verification.routes.js";
import walletRoutes from "./routes/wallet.routes.js";
import positionsRoutes from "./routes/positions.routes.js";
import tradeRoutes from "./routes/trade.routes.js";

import { startRiskWatcher } from "./jobs/risk.job.js";

// NUEVOS IMPORTS REALTIME
import PolygonSocket from "./sockets/polygonSocket.js";
import PriceHandler from "./utils/priceHandler.js";
import marketRoutesFactory from "./routes/market.routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ENV CONFIG
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

// mongoose listeners
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
   CORS - whitelist dinámico (más seguro que origin: true)
   ====================================================== */

const allowedOrigins = new Set([
  process.env.CLIENT_URL,
  process.env.BASE_URL,
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:4000",
  "http://127.0.0.1:4000",
].filter(Boolean));

const corsOptions = {
  origin: (origin, callback) => {
    // allow requests with no origin (like mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    // allow same origin requests
    try {
      const url = new URL(origin);
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return callback(null, true);
    } catch (e) {}
    console.warn("CORS denied for origin:", origin);
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
};

app.use(cors(corsOptions));

/* ======================================================
   MIDDLEWARES
   ====================================================== */

// logger
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} › ${req.method} ${req.originalUrl}`);
  next();
});

// body parser
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

/* ======================================================
   HEALTH CHECK
   ====================================================== */
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    env: process.env.NODE_ENV || "dev",
    emailProvider: process.env.RESEND_API_KEY ? "resend" : (process.env.EMAIL_USER ? "smtp" : "none"),
    db: mongoose.connection.name || null,
    adminApiKeyConfigured: !!process.env.ADMIN_API_KEY,
  });
});

/* ======================================================
   ROUTES API (montadas temprano)
   ====================================================== */
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/verification", verificationRoutes);

app.use("/api/wallet", walletRoutes);
app.use("/api/positions", positionsRoutes);
app.use("/api/trade", tradeRoutes);

/* ======================================================
   FALLBACK / SAMPLE SYMBOLS (temporal)
   - Esto se mantendrá como fallback si no hay PriceHandler
   ====================================================== */

const SAMPLE_SYMBOLS = [
  { symbol: "BINANCE:BTCUSDT", label: "BTC/USDT", market: "Crypto" },
  { symbol: "BINANCE:ETHUSDT", label: "ETH/USDT", market: "Crypto" },
  { symbol: "OANDA:EUR_USD", label: "EUR/USD", market: "Forex" },
  { symbol: "NASDAQ:AAPL", label: "AAPL", market: "Stocks" },
  { symbol: "INDEX:SPX", label: "S&P 500", market: "Indices" },
  { symbol: "BINANCE:BCHUSDT", label: "BCH/USDT", market: "Crypto" },
  { symbol: "BINANCE:ADAUSDT", label: "ADA/USDT", market: "Crypto" },
  { symbol: "FOREX:USDJPY", label: "USD/JPY", market: "Forex" }
];

// Rutas aliases iniciales (si tu frontend pide cualquiera de estas)
app.get("/api/markets", (req, res) => res.json({ markets: ["Crypto", "Stocks", "Forex", "Indices", "Futures", "Bonds"] }));
app.get("/api/market/list", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/market/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/markets/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/api/symbols", (req, res) => res.json(SAMPLE_SYMBOLS));
app.get("/api/api/markets", (req, res) => res.json({ markets: ["Crypto", "Stocks", "Forex", "Indices"] }));

/* ======================================================
   SOCKET SERVER + POLYGON REALTIME (HTTP server)
   ====================================================== */

const httpServer = createServer(app);

const io = new IOServer(httpServer, {
  cors: {
    origin: Array.from(allowedOrigins).length ? Array.from(allowedOrigins) : (process.env.CLIENT_URL || "*"),
    methods: ["GET", "POST"],
    credentials: true,
  },
  // allowEIO3: true // habilita si clientes antiguos requieren Engine.IO v3
});

// Price handler instanciado con IO para emitir cuando haya updates
const priceHandler = new PriceHandler(io);

/* ======================================================
   POLYGON SOCKET - inicializar con cuidado
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

    // intentar conectar, pero captura errores internamente
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
   ROUTES dinámicas de mercado (factory)
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
   RUTA DINÁMICA /api/symbols (usa priceHandler si existe)
   ====================================================== */

app.get("/api/symbols", (req, res) => {
  try {
    // prefer priceHandler.prices si existe
    const prices = (priceHandler && priceHandler.prices) ? priceHandler.prices : null;
    if (prices && Object.keys(prices).length) {
      const arr = Object.keys(prices).map((k) => {
        return {
          symbol: k,
          label: (k.split(":").pop() || k).replace("_", "/"),
          market: (prices[k] && prices[k].market) ? prices[k].market : "Unknown"
        };
      });
      return res.json(arr);
    }
    // fallback
    return res.json(SAMPLE_SYMBOLS);
  } catch (err) {
    console.error("api/symbols error:", err);
    return res.json(SAMPLE_SYMBOLS);
  }
});

/* ======================================================
   SOCKET.IO CONNECTION HANDLERS
   ====================================================== */

io.on("connection", (socket) => {
  console.log("📡 Cliente conectado:", socket.id);

  // Enviar snapshot inicial
  try {
    socket.emit("prices_snapshot", priceHandler.prices || {});
  } catch (e) {
    socket.emit("prices_snapshot", {});
  }

  // soporte para requests desde frontend
  socket.on("request_prices_snapshot", () => {
    try {
      socket.emit("prices_snapshot", priceHandler.prices || {});
    } catch (e) {
      socket.emit("prices_snapshot", {});
    }
  });

  socket.on("request_symbols", () => {
    try {
      // si PriceHandler provee método para listar símbolos, úsalo
      if (priceHandler && typeof priceHandler.getSymbols === "function") {
        const syms = priceHandler.getSymbols();
        socket.emit("symbols_update", syms || []);
      } else if (priceHandler && priceHandler.prices) {
        const arr = Object.keys(priceHandler.prices).map((k) => ({
          symbol: k,
          label: (k.split(":").pop() || k).replace("_", "/"),
          market: (priceHandler.prices[k] && priceHandler.prices[k].market) ? priceHandler.prices[k].market : "Unknown"
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
      if (polygonSocket && typeof polygonSocket.subscribe === "function") polygonSocket.subscribe(symbol, kind);
      socket.join(symbol);
      console.log("subscribe:", socket.id, symbol, kind || "trades");
    } catch (e) {
      console.warn("subscribe error:", e);
    }
  });

  socket.on("unsubscribe", ({ symbol, kind } = {}) => {
    if (!symbol) return;
    try {
      if (polygonSocket && typeof polygonSocket.unsubscribe === "function") polygonSocket.unsubscribe(symbol, kind);
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
    message:
      process.env.NODE_ENV === "development" ? err.message : undefined,
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

  if (!process.env.POLYGON_API_KEY) console.warn("⚠️ POLYGON_API_KEY no configurado — realtime limitado");
  if (!process.env.RESEND_API_KEY) console.warn("⚠️ Resend no configurado — emails pueden usar SMTP o simulación");
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
