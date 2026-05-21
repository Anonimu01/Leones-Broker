/* ======================================================
   DOCUMENTS (CLIENTE Y ADMIN)
   ====================================================== */

import mongoose from "mongoose";
import { app } from "../path/to/your/server.js"; // Ajusta la ruta si es necesario
import { safeGetUserFromBearer, requireAdmin } from "../utils/auth.js"; // Ajusta según tus utilidades

// Modelo Document
const DocumentSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, default: "identity" },
    documentUrl: { type: String, required: true },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    adminNote: { type: String, default: "" }
  },
  { timestamps: true }
);

const Document = mongoose.models.Document || mongoose.model("Document", DocumentSchema);

// ======================================================
// Rutas
// ======================================================

// Admin: listar todos los documentos
app.get("/api/admin/documents", requireAdmin, async (req, res) => {
  try {
    const docs = await Document.find().sort({ createdAt: -1 });
    res.json({ ok: true, count: docs.length, documents: docs });
  } catch (err) {
    console.error("/api/admin/documents error:", err);
    res.status(500).json({ ok: false, error: "server_error", message: err.message });
  }
});

// Cliente: listar documentos propios
app.get("/api/documents", async (req, res) => {
  try {
    const user = await safeGetUserFromBearer(req);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    const docs = await Document.find({ userId: user._id }).sort({ createdAt: -1 });
    res.json({ ok: true, count: docs.length, documents: docs });
  } catch (err) {
    console.error("/api/documents error:", err);
    res.status(500).json({ ok: false, error: "server_error", message: err.message });
  }
});

export default Document;
