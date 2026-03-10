// controllers/auth.controller.js (PARCHEADO - debugable, fallback tokens, mejor logging)

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import User from "../models/user.model.js";
import { sendEmail } from "../utils/sendEmail.js";

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
const REQUIRE_EMAIL_VERIFICATION =
  (process.env.ENFORCE_EMAIL_VERIFICATION || "false").toLowerCase() === "true";

/* ============================
   DEBUG: mostrar estado de env (no imprimir secrets)
   ============================ */
console.log("[ENV DEBUG] JWT_SECRET present?:", !!process.env.JWT_SECRET);
console.log("[ENV DEBUG] ENFORCE_EMAIL_VERIFICATION:", process.env.ENFORCE_EMAIL_VERIFICATION);
console.log("[ENV DEBUG] BASE_URL:", process.env.BASE_URL ? "(set)" : "(not set)");

if (!JWT_SECRET) {
  console.error("⚠️ JWT_SECRET no está definido en .env — los tokens no se firmarán correctamente");
}

/* ============================
   HELPERS
   ============================ */

function sanitizeUser(userDoc) {
  if (!userDoc) return null;
  const u =
    typeof userDoc.toObject === "function"
      ? userDoc.toObject()
      : { ...userDoc };

  u.id = String(u._id || u.id || "");
  delete u._id;
  delete u.__v;
  // remove password fields
  delete u.password;
  delete u.passwordHash;
  // remove verification token fields (todas las variantes)
  delete u.verifyToken;
  delete u.verificationToken;
  delete u.verify_token;
  delete u.verification_token;
  delete u.verifyExpires;
  delete u.verify_expires;
  return u;
}

function signToken(user) {
  if (!JWT_SECRET) {
    console.error("[JWT ERROR] JWT_SECRET no configurado. process.env keys:", Object.keys(process.env).filter(k => k.includes("JWT") || k.includes("SECRET")));
    throw new Error("JWT_SECRET no configurado en el servidor");
  }
  try {
    return jwt.sign(
      {
        id: String(user._id || user.id),
        email: user.email,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
  } catch (e) {
    console.error("[JWT SIGN ERROR]", e && e.message ? e.message : e);
    throw e;
  }
}

/* ==============================
   REGISTER
   ============================== */

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
      // canonical fields used by controller
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

    // ruta de verificación: apunta a /api/auth/verify para que el link funcione
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
      // sendEmail soporta sendEmail(to, subject, html) y sendEmail({..})
      const mailResult = await sendEmail(normalizedEmail, "Verifica tu cuenta - Leones Broker", html);
      console.log("[MAIL] register: sendEmail result:", mailResult);
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
   ============================== */

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

    // bloqueo por verificación si está activado en env
    if (user.verified === false && REQUIRE_EMAIL_VERIFICATION) {
      return res.status(403).json({
        ok: false,
        message: "Cuenta no verificada. Revisa tu correo.",
      });
    }

    let token;
    try {
      console.log("[SIGN DEBUG] About to sign token for user id:", user && (user._id || user.id));
      console.log("[SIGN DEBUG] JWT_SECRET length:", process.env.JWT_SECRET ? process.env.JWT_SECRET.length : 0);
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
   RESEND VERIFICATION
   ============================== */

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
      const mailResult = await sendEmail(normalizedEmail, "Reenviar verificación - Leones Broker", html);
      console.log("[MAIL] resendVerification: sendEmail result:", mailResult);
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

/* ==============================
   VERIFY
   ============================== */

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

    // fallback: acepta verifyToken o verificationToken (y variantes)
    const actualToken = user.verifyToken || user.verificationToken || user.verify_token || user.verification_token || null;

    if (actualToken !== token)
      return res.status(400).json({ ok: false, message: "Token inválido" });

    const expires = user.verifyExpires || user.verify_expires || null;
    if (expires && expires < new Date())
      return res.status(400).json({ ok: false, message: "Token expirado" });

    user.verified = true;
    user.verifyToken = undefined;
    user.verifyExpires = undefined;
    // also clear other potential fields
    if (user.verificationToken) user.verificationToken = undefined;
    if (user.verify_expires) user.verify_expires = undefined;

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

/* ==============================
   EXPORTS / COMPAT
   ============================== */

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
