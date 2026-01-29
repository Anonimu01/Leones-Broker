import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";

import User from "../models/User.js";
import { sendEmail } from "../utils/sendEmail.js";

const router = express.Router();

// REGISTRO
router.post("/register", async (req, res) => {
  const { name, email, password } = req.body;

  const exists = await User.findOne({ email });
  if (exists)
    return res.status(400).json({ msg: "Correo ya registrado" });

  const hash = await bcrypt.hash(password, 10);

  const token = crypto.randomBytes(32).toString("hex");

  const user = await User.create({
    name,
    email,
    password: hash,
    verificationToken: token
  });

  const link = `${process.env.BASE_URL}/api/verify/email/${token}`;

  await sendEmail(
    email,
    "Confirma tu cuenta",
    `
    <h2>Bienvenido a Leones Broker</h2>
    <p>Haz clic para confirmar tu correo:</p>
    <a href="${link}">${link}</a>
    `
  );

  res.json({
    msg: "Registro exitoso. Revisa tu correo."
  });
});

// LOGIN
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });
  if (!user)
    return res.status(400).json({ msg: "Credenciales inválidas" });

  if (!user.verified)
    return res.status(401).json({ msg: "Correo no verificado" });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid)
    return res.status(400).json({ msg: "Credenciales inválidas" });

  const token = jwt.sign(
    { id: user._id },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({ token, user });
});

export default router;
