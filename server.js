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

/**
 * Calcular __dirname para ESM y luego cargar .env desde la misma carpeta del server.js.
 * En producción (process.env.NODE_ENV === "production") dotenv no cargará archivo,
 * permitiendo que el proveedor (Render, Heroku) use sus env vars.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path:
    process.env.NODE_ENV === "production"
      ? undefined
      : path.resolve(__dirname, ".env"),
});

const app = express();

// En entornos detrás de un proxy (Render, Heroku...) ayuda con cookies seguras/sesiones
app.set("trust proxy", 1);

// Conectar a la base de datos (connectDB debería encargarse de la conexión mongoose)
// Se ejecuta después de dotenv.config para garantizar que MONGO_URI esté presente.
connectDB();

// Monitoreo simple de la conexión mongoose (útil para debug)
mongoose.connection.on("connected", () => {
  console.log("✅ MongoDB conectado. DB name:", mongoose.connection.name);
});
mongoose.connection.on("error", (err) => {
  console.error("❌ MongoDB connection error:", err);
});
mongoose.connection.on("disconnected", () => {
  console.warn("⚠️ MongoDB desconectado");
});

// Middlewares
const corsOptions = {
  origin: process.env.CLIENT_URL || true,
  credentials: true,
};
app.use(cors(corsOptions));

// Logger simple para debug (puedes quitarlo en producción)
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} › ${req.method} ${req.originalUrl}`);
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ruta de estado (healthcheck)
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    environment: process.env.NODE_ENV || "development",
    emailConfigured: !!(process.env.RESEND_API_KEY || (process.env.EMAIL_USER && process.env.EMAIL_PASS)),
    db: mongoose.connection.name || null,
  });
});

// RUTAS API
app.use("/api/auth", authRoutes);

// Montar rutas de usuario en ambas variantes para compatibilidad (no romper front existente)
// preferible usar "/api/users" (plural) pero dejamos "/api/user" también si hay llamadas viejas.
app.use("/api/users", userRoutes);
app.use("/api/user", userRoutes);

// Montar rutas de verificación en dos prefijos (compatibilidad)
app.use("/api/verification", verificationRoutes);
app.use("/api/verify", verificationRoutes);

// Si la petición comienza con /api y llegó hasta aquí, la ruta no existe: devolver 404 JSON.
// Esto evita que el catch-all del frontend sirva index.html para rutas API inexistentes.
app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found" });
});

// FRONTEND: servir archivos estáticos (build)
app.use(express.static(path.join(__dirname, "public")));

// Catch-all: devolver index.html para las rutas del frontend (SPA)
// Esto solo se ejecutará en peticiones que no empiecen por /api
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// Error handler básico (mejor detalle en desarrollo)
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

  // MOSTRAR estado de variables sin imprimir secretos
  console.log("📌 Env check:");
  console.log("  - RESEND_API_KEY set:", !!process.env.RESEND_API_KEY);
  console.log("  - SENDER_EMAIL set:", !!process.env.SENDER_EMAIL);
  console.log("  - EMAIL_USER set:", !!process.env.EMAIL_USER);
  console.log("  - EMAIL_PASS set:", !!process.env.EMAIL_PASS);
  console.log("  - MONGO_URI set:", !!process.env.MONGO_URI);
  if (!process.env.RESEND_API_KEY && (!process.env.EMAIL_USER || !process.env.EMAIL_PASS)) {
    console.warn(
      "⚠️ No hay proveedor de email completamente configurado. Define RESEND_API_KEY + SENDER_EMAIL (recomendado) o EMAIL_USER + EMAIL_PASS para SMTP."
    );
  }
});

// Manejo de promesas no atrapadas / excepciones (evita app en estado inconsistente)
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  // aquí puedes decidir reiniciar el proceso o continuar
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  // opcional: cerrar el servidor si quieres reiniciarlo en fallo severo
  // server.close(()=> process.exit(1));
});

/**
 * Graceful shutdown (SIGINT/SIGTERM)
 * - mongoose.connection.close() ya no acepta callback; usamos promise/await.
 */
const gracefulShutdown = async (signal) => {
  try {
    console.log(`📴 Recibido ${signal}. Cerrando servidor...`);
    // cerrar servidor primero para dejar de aceptar conexiones nuevas
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    // luego cerrar conexión mongoose (await)
    try {
      await mongoose.connection.close();
      console.log("MongoDB connection closed. Saliendo.");
    } catch (err) {
      console.error("Error cerrando conexión MongoDB:", err);
    }
  } catch (err) {
    console.error("Error during graceful shutdown:", err);
  } finally {
    // Aseguramos salida
    process.exit(0);
  }
};

process.on("SIGINT", async () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", async () => gracefulShutdown("SIGTERM"));

export default app;
