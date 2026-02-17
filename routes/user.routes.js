import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/user.model.js";

const router = express.Router();


// ==========================
// MIDDLEWARE AUTH
// ==========================
const authMiddleware = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token)
      return res.status(401).json({ msg: "No autorizado" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.id;

    next();

  } catch {
    res.status(401).json({ msg: "Token inválido" });
  }
};


// ==========================
// PERFIL USUARIO
// ==========================
router.get("/profile", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("-password -verificationToken");

    if (!user)
      return res.status(404).json({ msg: "Usuario no encontrado" });

    res.json(user);

  } catch (error) {
    console.error(error);
    res.status(500).json({ msg: "Error servidor" });
  }
});


export default router;
