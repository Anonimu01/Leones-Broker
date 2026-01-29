import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";

const router = express.Router();

/* ===============================
   REGISTRO
================================ */
router.post("/register", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ msg: "Datos incompletos" });

    const exist = await User.findOne({ email });
    if (exist)
      return res.status(400).json({ msg: "Usuario ya existe" });

    const hash = await bcrypt.hash(password, 10);

    const user = await User.create({
      email,
      password: hash,
      role: "user"
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ msg: "Error al registrar" });
  }
});

/* ===============================
   LOGIN
================================ */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user)
      return res.status(400).json({ msg: "Usuario no existe" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid)
      return res.status(400).json({ msg: "Contraseña incorrecta" });

    const token = jwt.sign(
      {
        id: user._id,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        balance: user.balance,
        leverage: user.leverage,
        verified: user.verified
      }
    });
  } catch (err) {
    res.status(500).json({ msg: "Error al iniciar sesión" });
  }
});

export default router;
