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

// Permite que Express confíe en el proxy (útil en Render, Heroku u otros proxies)
// Esto ayuda con cookies seguras y sesiones cuando tu app está detrás de un proxy.
app.set("trust proxy", 1);

connectDB();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());

// API
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/verify", verificationRoutes);

// FRONTEND
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Cliente activo en puerto", PORT);
});
