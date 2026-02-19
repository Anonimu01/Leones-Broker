// controllers/auth.controller.js
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
// IMPORT CORREGIDO: apunta al archivo real en /models (user.model.js)
import User from "../models/user.model.js";
import { sendEmail } from "../utils/sendEmail.js";

// ============================
// REGISTER
// ============================
export const registerUser = async (req, res) => {
  try {
    let { name, email, password, phone, address } = req.body;

    // validaciones básicas
    if (!name || !email || !password || !phone || !address) {
      return res.status(400).json({ msg: "Todos los campos son obligatorios" });
    }

    // normalizar
    name = String(name).trim();
    email = String(email).toLowerCase().trim();
    phone = String(phone).trim();
    address = String(address).trim();

    // verificar si existe email
    const exists = await User.findOne({ email });
    if (exists) {
      return res.status(400).json({ msg: "Correo ya registrado" });
    }

    // hashear contraseña
    const hash = await bcrypt.hash(password, 10);
    const token = crypto.randomBytes(32).toString("hex");

    // crear usuario (guardamos con los campos esperados por el schema)
    const user = await User.create({
      name,
      email,
      password: hash,
      phone,
      address,
      verified: false,
      verificationToken: token
    });

    // enlace de verificación (asegura que BASE_URL no tenga slash al final)
    const base = (process.env.BASE_URL || "").replace(/\/+$/, "");
    const link = `${base || ""}/api/verify/email/${token}`;

    // enviar correo (si falla, no borramos usuario; solo registramos en logs y devolvemos flag)
    let mailSent = false;
    try {
      await sendEmail(
        email,
        "Confirma tu cuenta",
        `
        <h2>Bienvenido a Leones Broker</h2>
        <p>Haz clic para confirmar tu correo:</p>
        <a href="${link}">${link}</a>
        `
      );
      mailSent = true;
    } catch (mailErr) {
      console.error("sendEmail error:", mailErr);
      // mailSent queda false; usuario sigue creado con verificationToken para verificar más tarde
    }

    // responder sin exponer campos sensibles
    return res.status(201).json({
      msg: "Registro exitoso. Revisa tu correo para verificar la cuenta.",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        address: user.address
      },
      verificationSent: mailSent
    });

  } catch (error) {
    console.error("Error register:", error);

    // Si es error de validación de mongoose devolvemos detalle útil
    if (error && error.name === "ValidationError" && error.errors) {
      const details = {};
      for (const key in error.errors) {
        details[key] = error.errors[key].message || error.errors[key].kind;
      }
      return res.status(400).json({ msg: "Validation error", errors: details });
    }

    return res.status(500).json({ msg: "Error del servidor" });
  }
};

// ============================
// LOGIN
// ============================
export const loginUser = async (req, res) => {
  try {
    let { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ msg: "Datos incompletos" });

    email = String(email).toLowerCase().trim();

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

    // devolver token y datos básicos del usuario (sin password ni verificationToken)
    return res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        balance: user.balance ?? 0,
        phone: user.phone || "",
        address: user.address || ""
      }
    });

  } catch (error) {
    console.error("Error login:", error);
    return res.status(500).json({ msg: "Error del servidor" });
  }
};
