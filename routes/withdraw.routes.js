// routes/withdraw.routes.js
import express from "express";
import mongoose from "mongoose";
import multer from "multer";
import path from "path";
import fs from "fs";
import jwt from "jsonwebtoken";
import User from "../models/user.model.js";

const router = express.Router();

// ======================================================
// MIDDLEWARE: AUTENTICACIÓN
// ======================================================
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return res.status(401).json({ ok: false, error: "User not found" });

    req.user = user;
    next();
  } catch (err) {
    console.error("Auth error:", err);
    res.status(401).json({ ok: false, error: "Unauthorized" });
  }
}

// ======================================================
// MONGOOSE MODELS
// ======================================================
const withdrawSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  amount: { type: Number, required: true },
  account: { type: String, required: true },
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
  createdAt: { type: Date, default: Date.now },
});

const Withdraw = mongoose.models.Withdraw || mongoose.model("Withdraw", withdrawSchema);

const documentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, required: true }, // e.g., "Identificación", "Comprobante de domicilio"
  documentUrl: { type: String, required: true },
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
  createdAt: { type: Date, default: Date.now },
});

const Document = mongoose.models.Document || mongoose.model("Document", documentSchema);

// ======================================================
// MULTER CONFIG PARA SUBIR DOCUMENTOS
// ======================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join("uploads", "documents");
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = file.fieldname + "-" + Date.now() + ext;
    cb(null, name);
  },
});

const upload = multer({ storage });

// ======================================================
// RUTAS
// ======================================================

// 1️⃣ Solicitar retiro
router.post("/", requireAuth, async (req, res) => {
  try {
    const { amount, account } = req.body;
    if (!amount || !account) return res.status(400).json({ ok: false, error: "Amount and account required" });

    const withdraw = await Withdraw.create({
      userId: req.user._id,
      amount,
      account,
    });

    res.json({ ok: true, withdraw });
  } catch (err) {
    console.error("Error creating withdraw:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// 2️⃣ Subir documento
router.post("/document", requireAuth, upload.single("document"), async (req, res) => {
  try {
    const { type } = req.body;
    if (!type) return res.status(400).json({ ok: false, error: "Document type required" });
    if (!req.file) return res.status(400).json({ ok: false, error: "Document file required" });

    const documentUrl = `/uploads/documents/${req.file.filename}`;

    const doc = await Document.create({
      userId: req.user._id,
      type,
      documentUrl,
    });

    res.json({ ok: true, document: doc });
  } catch (err) {
    console.error("Error uploading document:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

// 3️⃣ Obtener documentos del usuario
router.get("/documents", requireAuth, async (req, res) => {
  try {
    const docs = await Document.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json({ ok: true, documents: docs });
  } catch (err) {
    console.error("Error fetching documents:", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  }
});

export default router;
