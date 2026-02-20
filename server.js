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

// connect to DB (connectDB should call mongoose.connect and handle errors)
connectDB();

// listeners for mongoose lifecycle
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

// Generic handlers for unexpected errors — log and attempt graceful shutdown
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  // try to shutdown gracefully
  gracefulShutdown("unhandledRejection").catch((e) => {
    console.error("Error during shutdown after unhandledRejection:", e);
    process.exit(1);
  });
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  // try to shutdown gracefully
  gracefulShutdown("uncaughtException").catch((e) => {
    console.error("Error during shutdown after uncaughtException:", e);
    process.exit(1);
  });
});

/**
 * Graceful shutdown helper:
 * - stop accepting new connections (server.close)
 * - wait for server to close
 * - disconnect mongoose via mongoose.disconnect() (returns a Promise)
 * - if something hangs, force exit after timeout
 */
let shuttingDown = false;
const gracefulShutdown = async (signal) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`📴 Recibido ${signal}. Cerrando servidor...`);

  // start a fallback timer to force exit if shutdown stalls
  const forceTimeout = setTimeout(() => {
    console.warn("Forzando salida después de timeout...");
    process.exit(1);
  }, 30_000);
  forceTimeout.unref();

  try {
    // stop accepting new connections
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          // If server.close errors, still proceed to try to disconnect mongoose
          console.error("Error closing HTTP server:", err);
          return reject(err);
        }
        console.log("HTTP server closed.");
        resolve();
      });
    });

    // disconnect mongoose cleanly
    // prefer mongoose.disconnect() over mongoose.connection.close(callback)
    await mongoose.disconnect();
    console.log("MongoDB connection closed. Saliendo.");

    clearTimeout(forceTimeout);
    process.exit(0);
  } catch (err) {
    console.error("Error during graceful shutdown:", err);
    clearTimeout(forceTimeout);
    process.exit(1);
  }
};

// Hook signals
process.on("SIGINT", () => {
  gracefulShutdown("SIGINT").catch((e) => {
    console.error("Shutdown failed on SIGINT:", e);
    process.exit(1);
  });
});
process.on("SIGTERM", () => {
  gracefulShutdown("SIGTERM").catch((e) => {
    console.error("Shutdown failed on SIGTERM:", e);
    process.exit(1);
  });
});

export default app;
