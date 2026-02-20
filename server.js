// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

import { connectDB } from "./config/db.js";

import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import verificationRoutes from "./routes/verification.routes.js";
import walletRoutes from "./routes/wallet.routes.js"; // ✅ AÑADIDO

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
  });
});

// ROUTES
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/verification", verificationRoutes);
app.use("/api/wallet", walletRoutes); // ✅ AÑADIDO

// 404 API
app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found" });
});

// STATIC FRONTEND
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// ERROR HANDLER
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({
    error: "Server error",
    message:
      process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);

  console.log("ENV STATUS:");
  console.log("RESEND:", !!process.env.RESEND_API_KEY);
  console.log("SENDER:", !!process.env.SENDER_EMAIL);
  console.log("MONGO:", !!process.env.MONGO_URI);

  if (!process.env.RESEND_API_KEY)
    console.warn("⚠️ Resend no configurado — emails fallarán");
});

// GRACEFUL SHUTDOWN
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
