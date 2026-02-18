import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { connectDB } from "./config/db.js";

import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import verificationRoutes from "./routes/verification.routes.js";

dotenv.config();

const app = express();

// En entornos detrás de un proxy (Render, Heroku...) ayuda con cookies seguras/sesiones
app.set("trust proxy", 1);

// Conectar a la base de datos
connectDB();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ruta de estado (healthcheck)
app.get("/api/health", (req, res) => {
  res.json({ ok: true, environment: process.env.NODE_ENV || "development" });
});

// RUTAS API
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/verify", verificationRoutes);

// Si la petición comienza con /api y llegó hasta aquí, la ruta no existe: devolver 404 JSON.
// Esto evita que el catch-all del frontend sirva index.html para rutas API inexistentes.
app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found" });
});

// FRONTEND: servir archivos estáticos (build)
app.use(express.static(path.join(__dirname, "public")));

// Catch-all: devolver index.html para las rutas del frontend (SPA)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// Error handler básico
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Server error" });
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`🚀 Servidor activo en puerto ${PORT}`);
});

// Manejo de promesas no atrapadas / excepciones (evita app en estado inconsistente)
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  // opcional: cerrar el servidor si quieres reiniciarlo en fallo severo
  // server.close(()=> process.exit(1));
});
