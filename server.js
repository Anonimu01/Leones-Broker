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

connectDB();

mongoose.connection.on("connected", () => {
  console.log("✅ MongoDB conectado. DB name:", mongoose.connection.name);
});
mongoose.connection.on("error", (err) => {
  console.error("❌ MongoDB connection error:", err);
});
mongoose.connection.on("disconnected", () => {
  console.warn("⚠️ MongoDB desconectado");
});

const corsOptions = {
  origin: process.env.CLIENT_URL || true,
  credentials: true,
};
app.use(cors(corsOptions));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} › ${req.method} ${req.originalUrl}`);
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    environment: process.env.NODE_ENV || "development",
    emailConfigured: !!process.env.EMAIL_USER || !!process.env.RESEND_API_KEY,
    db: mongoose.connection.name || null,
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/user", userRoutes);
app.use("/api/verification", verificationRoutes);
app.use("/api/verify", verificationRoutes);

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found" });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  const status = err.status || 500;
  const payload = { error: "Server error" };
  if (process.env.NODE_ENV === "development") {
    payload.message = err.message;
    payload.stack = err.stack;
  }
  res.status(status).json(payload);
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(
    `🚀 Servidor activo en puerto ${PORT} (env: ${process.env.NODE_ENV || "development"})`
  );

  console.log("📌 Env check:");
  console.log("  - RESEND_API_KEY set:", !!process.env.RESEND_API_KEY);
  console.log("  - SENDER_EMAIL set:", !!process.env.SENDER_EMAIL);
  console.log("  - EMAIL_USER set:", !!process.env.EMAIL_USER);
  console.log("  - EMAIL_PASS set:", !!process.env.EMAIL_PASS);
  console.log("  - MONGO_URI set:", !!process.env.MONGO_URI);

  if (!process.env.RESEND_API_KEY && (!process.env.EMAIL_USER || !process.env.EMAIL_PASS)) {
    console.warn(
      "⚠️ No hay proveedor de email configurado (ni RESEND_API_KEY ni EMAIL_USER/EMAIL_PASS). Los envíos fallarán."
    );
  }
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

// Graceful shutdown: usar promesas para mongoose.close()
const gracefulShutdown = (signal) => {
  console.log(`📴 Recibido ${signal}. Cerrando servidor...`);
  server.close(async () => {
    try {
      await mongoose.connection.close(false); // devuelve promise en mongoose v6+
      console.log("MongoDB connection closed. Saliendo.");
      process.exit(0);
    } catch (err) {
      console.error("Error closing MongoDB connection:", err);
      process.exit(1);
    }
  });

  // fallback timeout si algo queda colgado
  setTimeout(() => {
    console.warn("Forzando salida después de timeout...");
    process.exit(1);
  }, 30_000).unref();
};
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

export default app;
