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

// IMPORTS PARA POLYGON / REALTIME
import PolygonSocket from "./sockets/polygonSocket.js"; // asegúrate que exporta default
import PriceHandler from "./utils/priceHandler.js"; // asegúrate que exporta default
import marketRoutesFactory from "./routes/market.routes.js"; // si exporta factory: export default (deps)=>router

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

  // START RISK WATCHER after DB is connected
  try {
    const intervalMs = Number(process.env.RISK_JOB_INTERVAL_MS) || 30_000;
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

// ROUTES (API)
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/verification", verificationRoutes);

// CLIENT WALLET / POSITIONS / TRADE endpoints (protected routes used by client UI)
app.use("/api/wallet", walletRoutes);
app.use("/api/positions", positionsRoutes);
app.use("/api/trade", tradeRoutes);

// We'll mount market routes later after creating polygonSocket (see below)

// STATIC FRONTEND - sirve public y fallback
app.use(express.static(path.join(__dirname, "public")));

// create HTTP server + socket.io
const server = createServer(app);

const io = new IOServer(server, {
  cors: {
    origin: process.env.CLIENT_URL || "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// --- POLYGON + PRICE HANDLER SETUP ---

// instantiate Polygon socket (will manage connections lazily)
const polygonSocket = new PolygonSocket({
  apiKey: process.env.POLYGON_API_KEY || process.env.POLYGON_KEY || "",
});

// priceHandler emits 'price' events and also can broadcast using io
const priceHandler = new PriceHandler(io);

// forward events from polygonSocket into priceHandler
polygonSocket.on("data", ({ cls, item }) => {
  try {
    priceHandler.handlePolygonItem({ cls, item });
  } catch (e) {
    console.error("priceHandler.handlePolygonItem error:", e);
  }
});
polygonSocket.on("raw", (d) => {
  // optional debug
  // console.debug('polygon raw:', d);
});
polygonSocket.on("status", (s) => {
  console.info("polygon status", s);
});
polygonSocket.on("error", (err) => {
  console.warn("polygon error", err);
});

// Start polygon connections when server is ready (after DB connected OR immediately)
(async function startPolygon() {
  try {
    // start connections (PolygonSocket will ensure reconnection)
    await polygonSocket.start?.();
    console.log("✅ PolygonSocket.start() invoked");
  } catch (e) {
    console.error("Error iniciando PolygonSocket:", e);
  }
})();

// expose market API using router factory if provided (supports both styles)
try {
  if (typeof marketRoutesFactory === "function") {
    const marketRouter = marketRoutesFactory({ polygonSocket });
    app.use("/api/market", marketRouter);
  } else {
    // if the imported module is an Express Router already
    app.use("/api/market", marketRoutesFactory);
  }
} catch (e) {
  console.warn("No se pudo montar /api/market automaticamente:", e);
}

// SOCKET.IO CONNECTIONS (clients)
io.on("connection", (socket) => {
  console.log("socket client connected:", socket.id);

  // send current snapshot of prices
  try {
    socket.emit("prices_snapshot", priceHandler.prices || {});
  } catch (e) {
    console.warn("emit prices_snapshot error:", e);
  }

  // client asks server to subscribe to polygon symbol (this will make the server subscribe on Polygon)
  socket.on("subscribe", ({ symbol, kind }) => {
    try {
      if (!symbol) return;
      polygonSocket.subscribe(symbol, kind || "trades");
      socket.join(`sym:${symbol}`);
      console.log(`socket ${socket.id} requested subscribe ${symbol} (${kind || "trades"})`);
    } catch (e) {
      console.error("subscribe error:", e);
    }
  });

  socket.on("unsubscribe", ({ symbol, kind }) => {
    try {
      if (!symbol) return;
      polygonSocket.unsubscribe(symbol, kind || "trades");
      socket.leave(`sym:${symbol}`);
      console.log(`socket ${socket.id} requested unsubscribe ${symbol} (${kind || "trades"})`);
    } catch (e) {
      console.error("unsubscribe error:", e);
    }
  });

  socket.on("disconnect", (reason) => {
    console.log("socket disconnected:", socket.id, reason);
  });
});

// fallback for SPA (send index.html)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// ERROR HANDLER
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({
    error: "Server error",
    message: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);

  console.log("ENV STATUS:");
  console.log("RESEND:", !!process.env.RESEND_API_KEY);
  console.log("SENDER:", !!process.env.SENDER_EMAIL);
  console.log("MONGO:", !!process.env.MONGO_URI);
  console.log("ADMIN_API_KEY:", !!process.env.ADMIN_API_KEY);

  if (!process.env.RESEND_API_KEY)
    console.warn("⚠️ Resend no configurado — emails fallarán");
});

// GRACEFUL SHUTDOWN (close socket.io and polygon ws)
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
    // stop accepting new connections
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) return reject(err);
        console.log("HTTP cerrado");
        resolve();
      });
    });

    // close socket.io
    try {
      io.close();
      console.log("Socket.IO cerrado");
    } catch (e) {
      console.warn("Error cerrando socket.io", e);
    }

    // attempt to stop polygon socket connections gracefully (if implementation exposes stop/close)
    try {
      if (typeof polygonSocket.stop === "function") {
        await polygonSocket.stop();
        console.log("PolygonSocket detenido (stop())");
      } else if (typeof polygonSocket.close === "function") {
        polygonSocket.close();
        console.log("PolygonSocket cerrado (close())");
      } else if (polygonSocket.ws) {
        // try to close any underlying websockets (best-effort)
        try {
          Object.values(polygonSocket.ws).forEach((c) => { if (c && c.terminate) c.terminate(); });
          console.log("PolygonSocket ws connections terminated (best-effort)");
        } catch (er) { /* ignore */ }
      }
    } catch (e) {
      console.warn("Error cerrando PolygonSocket", e);
    }

    // stop risk watcher if module exposes stop (optional)
    try {
      // eslint-disable-next-line no-unused-vars
      if (typeof global?.stopRiskWatcher === "function") {
        global.stopRiskWatcher();
      }
    } catch (e) {
      // ignore
    }

    // disconnect mongoose
    try {
      await mongoose.disconnect();
      console.log("Mongo cerrado");
    } catch (e) {
      console.warn("Error disconnecting mongoose", e);
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
  gracefulShutdown("unhandledRejection");
});
process.on("uncaughtException", (e) => {
  console.error("UncaughtException:", e);
  gracefulShutdown("uncaughtException");
});

export default app;
