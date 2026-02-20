import express from "express";
import authMiddleware from "../middlewares/auth.middleware.js";
import User from "../models/user.model.js";

const router = express.Router();


// ==========================
// PERFIL USUARIO
// ==========================
router.get("/profile", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select("-password -verificationToken");

    if (!user)
      return res.status(404).json({ msg: "Usuario no encontrado" });

    res.json(user);

  } catch (error) {
    console.error("GET /profile error:", error);
    res.status(500).json({ msg: "Error servidor" });
  }
});


// ==========================
// WALLET DATA
// ==========================
router.get("/wallet/me", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user)
      return res.status(404).json({ msg: "Usuario no encontrado" });

    res.json({
      balance: user.balance || 0,
      currency: "USD",
      positions: []
    });

  } catch (err) {
    console.error("wallet error:", err);
    res.status(500).json({ msg: "Error obteniendo wallet" });
  }
});

export default router;
