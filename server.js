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

// ✅ NUEVOS IMPORTS REALTIME
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

// CORS
const corsOptions = {
  origin: process.env.CLIENT_URL || true,
  credentials: true,
};
app.use(cors(corsOptions));

// logger
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} › ${req.method} ${req.originalUrl}`);
  next();
});

// body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// HEALTH CHECK
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    env: process.env.NODE_ENV || "dev",
    emailProvider: process.env.RESEND_API_KEY ? "resend" : "smtp",
    db: mongoose.connection.name || null,
    adminApiKeyConfigured: !!process.env.ADMIN_API_KEY,
  });
});

// ROUTES
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/verification", verificationRoutes);

app.use("/api/wallet", walletRoutes);
app.use("/api/positions", positionsRoutes);
app.use("/api/trade", tradeRoutes);

/* ======================================================
   SIMPLE SYMBOLS ENDPOINTS ADDED (aliases para evitar 404)
   - Se colocaron aquí para que existan antes del 404 /api
   - Devuelven un listado simple de símbolos que puedes ampliar
====================================================== */

const SAMPLE_SYMBOLS = [
  { symbol: "BINANCE:BTCUSDT", label: "BTC/USDT", market: "Crypto" },
  { symbol: "BINANCE:ETHUSDT", label: "ETH/USDT", market: "Crypto" },
  { symbol: "OANDA:EUR_USD", label: "EUR/USD", market: "Forex" },
  { symbol: "NASDAQ:AAPL", label: "AAPL", market: "Stocks" }
];

// endpoint principal solicitado
app.get("/api/symbols", (req, res) => {
  res.json(SAMPLE_SYMBOLS);
});

// aliases comunes que aparecieron en tus logs (evitan 404)
app.get("/api/market/symbols", (req, res) => {
  res.json(SAMPLE_SYMBOLS);
});
app.get("/api/markets/symbols", (req, res) => {
  res.json(SAMPLE_SYMBOLS);
});
app.get("/api/markets", (req, res) => {
  res.json({ markets: ["Crypto", "Stocks", "Forex", "Indices"] });
});
app.get("/api/market/list", (req, res) => {
  res.json(SAMPLE_SYMBOLS);
});
// catch extra variant with duplicated /api prefix that apareced in logs
app.get("/api/api/symbols", (req, res) => {
  res.json(SAMPLE_SYMBOLS);
});
app.get("/api/api/markets", (req, res) => {
  res.json({ markets: ["Crypto", "Stocks", "Forex", "Indices"] });
});

/* ======================================================
   🚀 SOCKET SERVER + POLYGON REALTIME
====================================================== */

const httpServer = createServer(app);

const io = new IOServer(httpServer, {
  cors: {
    origin: process.env.CLIENT_URL || "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// iniciar manejador de precios
const priceHandler = new PriceHandler(io);

// iniciar socket polygon
const polygonSocket = new PolygonSocket({
  apiKey: process.env.POLYGON_API_KEY,
  onPrice: (data) => priceHandler.handle(data),
});

polygonSocket.connect();

// market routes dinámico
try {
  if (typeof marketRoutesFactory === "function") {
    app.use("/api/market", marketRoutesFactory({ polygonSocket }));
  } else {
    app.use("/api/market", marketRoutesFactory);
  }
} catch (e) {
  console.warn("No se pudo montar /api/market:", e.message);
}

// sockets cliente
io.on("connection", (socket) => {
  console.log("📡 Cliente conectado:", socket.id);

  socket.emit("prices_snapshot", priceHandler.prices || {});

  socket.on("subscribe", ({ symbol }) => {
    if (!symbol) return;
    polygonSocket.subscribe(symbol);
    socket.join(symbol);
  });

  socket.on("unsubscribe", ({ symbol }) => {
    if (!symbol) return;
    polygonSocket.unsubscribe(symbol);
    socket.leave(symbol);
  });

  socket.on("disconnect", () => {
    console.log("❌ Cliente desconectado:", socket.id);
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

  if (!process.env.RESEND_API_KEY)
    console.warn("⚠️ Resend no configurado — emails fallarán");
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
      if (typeof polygonSocket.close === "function") {
        polygonSocket.close();
      }
    } catch {}

    try {
      if (typeof global?.stopRiskWatcher === "function") {
        global.stopRiskWatcher();
      }
    } catch {}

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
