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

// Send email helper
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

// Mongo events
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

mongoose.connection.on("error", (err) => {
  console.error("❌ Mongo error:", err);
});

mongoose.connection.on("disconnected", () => {
  console.warn("⚠️ Mongo desconectado");
});

/* ================= SECURITY ================= */
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(mongoSanitize());
app.use(xss());

/* ================= CORS ================= */
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

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.has(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "10mb" }));

/* ================= ROUTES ================= */
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/verification", verificationRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/positions", positionsRoutes);
app.use("/api/trade", tradeRoutes);
app.use("/api/account", accountRoutes);

/* ================= SOCKET ================= */
const httpServer = createServer(app);

const io = new IOServer(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const priceHandler = new PriceHandler(io);

/* ================= POLYGON ================= */
let polygonSocket = null;

if (process.env.POLYGON_API_KEY) {
  polygonSocket = new PolygonSocket({
    apiKey: process.env.POLYGON_API_KEY,
    onPrice: (data) => priceHandler.handle(data),
  });

  polygonSocket.connect().catch(() => {
    polygonSocket = null;
  });
}

/* ================= MARKET ROUTES ================= */
if (typeof marketRoutesFactory === "function") {
  app.use("/api/market", marketRoutesFactory({ polygonSocket, priceHandler }));
}

/* ================= BASIC ENDPOINT ================= */
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

/* ================= STATIC ================= */
const staticPath = path.join(__dirname, "public");
app.use(express.static(staticPath));

/* ================= FALLBACK ================= */
app.get("*", (req, res) => {
  res.sendFile(path.join(staticPath, "index.html"));
});

/* ================= ERROR ================= */
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

/* ================= START ================= */
const PORT = process.env.PORT || 3000;

const server = httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});

/* ================= SHUTDOWN ================= */
process.on("SIGINT", async () => {
  await mongoose.disconnect();
  process.exit(0);
});

export default app;
