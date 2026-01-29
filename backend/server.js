import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { connectDB } from "./config/db.js";

import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import withdrawRoutes from "./routes/withdraw.routes.js";
import verificationRoutes from "./routes/verification.routes.js";

dotenv.config();

const app = express();

/* ===============================
   CONFIG PATH (ES MODULE)
================================ */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ===============================
   DATABASE
================================ */
connectDB();

/* ===============================
   MIDDLEWARE
================================ */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ===============================
   API ROUTES
================================ */
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/withdraw", withdrawRoutes);
app.use("/api/verify", verificationRoutes);

/* ===============================
   STATIC FILES
================================ */
app.use(express.static(path.join(__dirname, "public")));

/* ===============================
   ADMIN FRONTEND
================================ */
app.get("/admin", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "admin", "index.html")
  );
});

/* ===============================
   CLIENT FRONTEND
================================ */
app.get("*", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "cliente", "index.html")
  );
});

/* ===============================
   SERVER START
================================ */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Backend Leones Broker activo en puerto ${PORT}`);
});
