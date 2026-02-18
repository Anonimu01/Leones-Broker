import express from "express";
import { registerUser, loginUser } from "../controllers/auth.controller.js";

const router = express.Router();


// ============================
// HEALTH CHECK AUTH ROUTES
// ============================
router.get("/ping", (req, res) => {
  res.json({ msg: "Auth routes funcionando ✅" });
});


// ============================
// REGISTRO
// ============================
router.post("/register", async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ msg: "Todos los campos son obligatorios" });

    await registerUser(req, res);
  } catch (err) {
    next(err);
  }
});


// ============================
// LOGIN
// ============================
router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ msg: "Email y contraseña requeridos" });

    await loginUser(req, res);
  } catch (err) {
    next(err);
  }
});


export default router;
