// controllers/auth.controller.js (PARCHE - usa ENFORCE_EMAIL_VERIFICATION y ruta de verify corregida)

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import User from "../models/user.model.js";
import { sendEmail } from "../utils/sendEmail.js";

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
// ahora usamos ENFORCE_EMAIL_VERIFICATION para decidir si obligamos verificación
const REQUIRE_EMAIL_VERIFICATION =
  (process.env.ENFORCE_EMAIL_VERIFICATION || "false").toLowerCase() === "true";

if (!JWT_SECRET) {
  console.error("⚠️ JWT_SECRET no está definido en .env — los tokens no se firmarán correctamente");
}

function sanitizeUser(userDoc) {
  if (!userDoc) return null;
  const u =
    typeof userDoc.toObject === "function"
      ? userDoc.toObject()
      : { ...userDoc };

  u.id = String(u._id || u.id || "");
  delete u._id;
  delete u.__v;
  delete u.password;
  delete u.passwordHash;
  delete u.verifyToken;
  delete u.verifyExpires;
  return u;
}

function signToken(user) {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET no configurado en el servidor");
  }
  return jwt.sign(
    {
      id: String(user._id || user.id),
      email: user.email,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/* ==============================
   REGISTER
   ============================= */

export async function register(req, res) {
  try {
    const { name, email, password, phone, address } = req.body || {};

    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ ok: false, message: "name, email y password requeridos" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const existing = await User.findOne({ email: normalizedEmail }).exec();
    if (existing) {
      return res
        .status(409)
        .json({ ok: false, message: "El correo ya está registrado" });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const verifyToken = crypto.randomBytes(24).toString("hex");
    const verifyExpires = new Date(
      Date.now() +
        (Number(process.env.VERIFY_TOKEN_TTL_MS) || 1000 * 60 * 60 * 24)
    );

    const newUser = new User({
      name,
      email: normalizedEmail,
      password: passwordHash,
      passwordHash,
      phone: phone || "",
      address: address || "",
      verified: false,
      verifyToken,
      verifyExpires,
      createdAt: new Date(),
    });

    await newUser.save();

    // token de sesión inmediato (si quieres obligar verificación, cambia lógica)
    let token = null;
    try {
      token = signToken(newUser);
    } catch (e) {
      console.error("Could not sign token after register:", e.message || e);
      token = null;
    }

    // CORREGIDO: la ruta de verificación completa para que el link funcione
    const verifyUrl = `${BASE_URL}/api/auth/verify?token=${verifyToken}&email=${encodeURIComponent(
      normalizedEmail
    )}`;

    const html = `
      <p>Hola ${newUser.name},</p>
      <p>Gracias por registrarte en Leones Broker.</p>
      <p>Haz clic aquí para verificar tu cuenta:</p>
      <p><a href="${verifyUrl}">Verificar cuenta</a></p>
    `;

    try {
      await sendEmail(normalizedEmail, "Verifica tu cuenta - Leones Broker", html);
    } catch (err) {
      console.error("Error enviando email de verificación:", err && err.message ? err.message : err);
    }

    return res.status(201).json({
      ok: true,
      message: "Usuario creado",
      data: {
        token, // puede ser null si signing falló (pero usuario creado)
        user: sanitizeUser(newUser),
      },
    });
  } catch (err) {
    console.error("REGISTER ERROR:", err && err.message ? err.message : err);
    return res.status(500).json({
      ok: false,
      message: "Error creando usuario",
    });
  }
}

/* ==============================
   LOGIN
   ============================= */

export async function login(req, res) {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res
        .status(400)
        .json({ ok: false, message: "email y password requeridos" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const user = await User.findOne({ email: normalizedEmail }).exec();
    if (!user) {
      return res
        .status(401)
        .json({ ok: false, message: "Credenciales inválidas" });
    }

    const hashed = String(user.password || user.passwordHash || "");
    const match = await bcrypt.compare(password, hashed);

    if (!match) {
      return res
        .status(401)
        .json({ ok: false, message: "Credenciales inválidas" });
    }

    // ahora usamos ENFORCE_EMAIL_VERIFICATION (si está true exige verified)
    if (user.verified === false && REQUIRE_EMAIL_VERIFICATION) {
      return res.status(403).json({
        ok: false,
        message: "Cuenta no verificada. Revisa tu correo.",
      });
    }

    let token;
    try {
      token = signToken(user);
    } catch (e) {
      console.error("Token sign error:", e && e.message ? e.message : e);
      return res.status(500).json({ ok: false, message: "Error generando token" });
    }

    return res.json({
      ok: true,
      message: "Login correcto",
      data: {
        token,
        user: sanitizeUser(user),
        verified: !!user.verified,
      },
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err && err.message ? err.message : err);
    return res.status(500).json({
      ok: false,
      message: "Error en login",
    });
  }
}

/* ==============================
   RESEND VERIFICATION & VERIFY
   ==============================
   (sin cambios funcionales importantes salvo la ruta usada en el email)
*/

export async function resendVerification(req, res) {
  try {
    const { email } = req.body || {};

    if (!email)
      return res.status(400).json({ ok: false, message: "email requerido" });

    const normalizedEmail = String(email).trim().toLowerCase();

    const user = await User.findOne({ email: normalizedEmail }).exec();
    if (!user)
      return res
        .status(404)
        .json({ ok: false, message: "Usuario no encontrado" });

    if (user.verified)
      return res
        .status(400)
        .json({ ok: false, message: "Cuenta ya verificada" });

    const verifyToken = crypto.randomBytes(24).toString("hex");
    user.verifyToken = verifyToken;
    user.verifyExpires = new Date(Date.now() + 1000 * 60 * 60 * 24);
    await user.save();

    const verifyUrl = `${BASE_URL}/api/auth/verify?token=${verifyToken}&email=${encodeURIComponent(
      normalizedEmail
    )}`;

    const html = `
      <p>Hola ${user.name}</p>
      <p>Haz clic para verificar tu cuenta:</p>
      <p><a href="${verifyUrl}">Verificar cuenta</a></p>
    `;

    try {
      await sendEmail(normalizedEmail, "Reenviar verificación - Leones Broker", html);
    } catch (err) {
      console.error("resendVerification sendEmail error:", err && err.message ? err.message : err);
      return res.status(500).json({ ok: false, message: "Error enviando email" });
    }

    return res.json({
      ok: true,
      message: "Correo enviado",
    });
  } catch (err) {
    console.error("RESEND ERROR:", err && err.message ? err.message : err);
    return res.status(500).json({
      ok: false,
      message: "Error interno",
    });
  }
}

export async function verify(req, res) {
  try {
    const { token, email } = req.query || {};

    if (!token || !email)
      return res
        .status(400)
        .json({ ok: false, message: "token y email requeridos" });

    const normalizedEmail = String(email).trim().toLowerCase();

    const user = await User.findOne({ email: normalizedEmail }).exec();
    if (!user)
      return res
        .status(404)
        .json({ ok: false, message: "Usuario no encontrado" });

    if (user.verifyToken !== token)
      return res.status(400).json({ ok: false, message: "Token inválido" });

    if (user.verifyExpires && user.verifyExpires < new Date())
      return res.status(400).json({ ok: false, message: "Token expirado" });

    user.verified = true;
    user.verifyToken = undefined;
    user.verifyExpires = undefined;

    await user.save();

    return res.json({
      ok: true,
      message: "Cuenta verificada",
    });
  } catch (err) {
    console.error("VERIFY ERROR:", err && err.message ? err.message : err);
    return res.status(500).json({
      ok: false,
      message: "Error interno",
    });
  }
}

export const loginUser = login;
export const registerUser = register;
export const resendVerificationUser = resendVerification;
export const verifyUser = verify;

export default {
  register,
  login,
  resendVerification,
  verify,
};
