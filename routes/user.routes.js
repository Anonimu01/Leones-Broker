import express from "express";
import { authMiddleware } from "../middleware/auth.middleware.js";

const router = express.Router();

// ==========================
// PERFIL USUARIO (PROTEGIDO)
// ==========================
router.get("/profile", authMiddleware, async (req, res) => {
  try {
    // authMiddleware adjunta el usuario real en req.user
    if (!req.user) return res.status(404).json({ msg: "Usuario no encontrado" });

    res.json(req.user);

  } catch (error) {
    console.error("GET /profile error:", error);
    res.status(500).json({ msg: "Error servidor" });
  }
});

export default router;
