// controllers/auth.controller.js
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import User from "../models/user.model.js";
import { sendEmail } from "../utils/sendEmail.js";

const JWT_SECRET = process.env.JWT_SECRET || "changeme";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
const ALLOW_LOGIN_UNVERIFIED = (process.env.ALLOW_LOGIN_UNVERIFIED || "false").toLowerCase() === "true";

function sanitizeUser(userDoc) {
  if (!userDoc) return null;
  const u = typeof userDoc.toObject === "function" ? userDoc.toObject() : { ...userDoc };
  // Campos que no queremos devolver al cliente
  delete u.password;
  delete u.passwordHash;
  delete u.verifyToken;
  delete u.verifyExpires;
  return u;
}

function signToken(userId) {
  return jwt.sign({ id: String(userId) }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * POST /api/auth/register
 * Body: { name, email, password, phone?, address? }
 */
export async function register(req, res) {
  try {
    const { name, email, password, phone, address } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ ok: false, message: "name, email y password son requeridos" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    // Check existing user
    const existing = await User.findOne({ email: normalizedEmail }).exec();
    if (existing) {
      return res.status(409).json({ ok: false, message: "El correo ya está registrado" });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Create verification token
    const verifyToken = crypto.randomBytes(24).toString("hex");
    const verifyExpires = new Date(Date.now() + (Number(process.env.VERIFY_TOKEN_TTL_MS) || 1000 * 60 * 60 * 24)); // 24h default

    const newUser = new User({
      name,
      email: normalizedEmail,
      // Guardamos en ambos campos por compatibilidad con distintos esquemas
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

    // create jwt token for immediate session (opcional)
    const token = signToken(newUser._id);

    // Build verification link
    const verifyUrl = BASE_URL
      ? `${BASE_URL}/verify?token=${verifyToken}&email=${encodeURIComponent(normalizedEmail)}`
      : `/verify?token=${verifyToken}&email=${encodeURIComponent(normalizedEmail)}`;

    const html = `
      <p>Hola ${sanitizeUser(newUser).name || ""},</p>
      <p>Gracias por registrarte en Leones Broker. Por favor verifica tu correo usando el enlace a continuación:</p>
      <p><a href="${verifyUrl}">Verificar mi cuenta</a></p>
      <p>Si no solicitaste esto, ignora este correo.</p>
    `;

    // Try to send verification email (do not make registration fail if email provider misconfigured)
    let emailResult = null;
    try {
      // sendEmail expects (to, subject, html)
      emailResult = await sendEmail(normalizedEmail, "Verifica tu cuenta - Leones Broker", html);
      console.log("[AUTH] sendEmail result:", emailResult);
    } catch (e) {
      console.error("[AUTH] Error enviando email de verificación:", e && e.message ? e.message : e);
      emailResult = { ok: false, error: e && e.message ? e.message : String(e) };
    }

    const userSafe = sanitizeUser(newUser);

    return res.status(201).json({
      ok: true,
      message: "Usuario creado",
      data: { token, user: userSafe },
      email_sent: !!(emailResult && emailResult.ok),
      email_result: emailResult,
    });
  } catch (err) {
    console.error("[AUTH] register error:", err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, message: "Error creando usuario", error: err && err.message ? err.message : String(err) });
  }
}

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
export async function login(req, res) {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, message: "email y password requeridos" });

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail }).exec();
    if (!user) return res.status(401).json({ ok: false, message: "Credenciales inválidas" });

    // Compare password against both possible fields
    const hashedCandidate = user.password || user.passwordHash || "";
    const match = await bcrypt.compare(password, hashedCandidate);
    if (!match) return res.status(401).json({ ok: false, message: "Credenciales inválidas" });

    // Handle verification policy
    if (user.verified === false && !ALLOW_LOGIN_UNVERIFIED) {
      // Si NO permitimos login de no verificados, devolvemos 403 con mensaje claro
      return res.status(403).json({ ok: false, message: "Cuenta no verificada. Revisa tu correo." });
    }

    // Generar token correctamente (corregido typo)
    const token = signToken(user._id);
    const userSafe = sanitizeUser(user);

    // Incluir campo verified para que el frontend pueda reaccionar en caso necesario
    return res.json({ ok: true, message: "Login correcto", data: { token, user: userSafe, verified: !!user.verified } });
  } catch (err) {
    console.error("[AUTH] login error:", err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, message: "Error en login", error: err && err.message ? err.message : String(err) });
  }
}

/**
 * POST /api/auth/resend-verification
 * Body: { email }
 */
export async function resendVerification(req, res) {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, message: "email requerido" });

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail }).exec();
    if (!user) return res.status(404).json({ ok: false, message: "Usuario no encontrado" });
    if (user.verified) return res.status(400).json({ ok: false, message: "Cuenta ya verificada" });

    // create a new token if expired or absent
    const now = new Date();
    let verifyToken = user.verifyToken;
    if (!verifyToken || (user.verifyExpires && user.verifyExpires < now)) {
      verifyToken = crypto.randomBytes(24).toString("hex");
      user.verifyToken = verifyToken;
      user.verifyExpires = new Date(Date.now() + (Number(process.env.VERIFY_TOKEN_TTL_MS) || 1000 * 60 * 60 * 24));
      await user.save();
    }

    const verifyUrl = BASE_URL
      ? `${BASE_URL}/verify?token=${verifyToken}&email=${encodeURIComponent(normalizedEmail)}`
      : `/verify?token=${verifyToken}&email=${encodeURIComponent(normalizedEmail)}`;

    const html = `
      <p>Hola ${user.name || ""},</p>
      <p>Haz solicitado re-enviar el correo de verificación. Haz clic abajo:</p>
      <p><a href="${verifyUrl}">Verificar mi cuenta</a></p>
    `;

    let emailResult = null;
    try {
      // sendEmail expects (to, subject, html)
      emailResult = await sendEmail(normalizedEmail, "Reenviar verificación - Leones Broker", html);
      console.log("[AUTH] resendVerification sendEmail:", emailResult);
      return res.json({ ok: true, message: "Correo de verificación enviado", email_result: emailResult });
    } catch (e) {
      console.error("[AUTH] resendVerification email error:", e && e.message ? e.message : e);
      return res.status(500).json({ ok: false, message: "Error enviando email", error: e && e.message ? e.message : String(e) });
    }
  } catch (err) {
    console.error("[AUTH] resendVerification error:", err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, message: "Error interno", error: err && err.message ? err.message : String(err) });
  }
}

/**
 * GET /api/auth/verify?token=...&email=...
 */
export async function verify(req, res) {
  try {
    const { token, email } = req.query || {};
    if (!token || !email) return res.status(400).json({ ok: false, message: "token y email requeridos" });

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail }).exec();
    if (!user) return res.status(404).json({ ok: false, message: "Usuario no encontrado" });

    if (user.verified) return res.json({ ok: true, message: "Cuenta ya verificada" });

    if (!user.verifyToken || user.verifyToken !== token) {
      return res.status(400).json({ ok: false, message: "Token inválido" });
    }

    if (user.verifyExpires && user.verifyExpires < new Date()) {
      return res.status(400).json({ ok: false, message: "Token expirado" });
    }

    user.verified = true;
    user.verifyToken = undefined;
    user.verifyExpires = undefined;
    await user.save();

    return res.json({ ok: true, message: "Cuenta verificada" });
  } catch (err) {
    console.error("[AUTH] verify error:", err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, message: "Error interno", error: err && err.message ? err.message : String(err) });
  }
}

/* ---- Compatibility aliases ----
   Some routes import different names (e.g. loginUser). Provide aliases so
   both styles work and deployments don't fail due to export name mismatch.
*/
export const loginUser = login;
export const registerUser = register;
export const resendVerificationUser = resendVerification;
export const verifyUser = verify;

/* Default export kept for backwards compatibility */
export default { register, login, resendVerification, verify };
