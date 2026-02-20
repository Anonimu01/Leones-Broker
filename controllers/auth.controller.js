// controllers/auth.controller.js
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
// IMPORT CORREGIDO: apunta al archivo real en /models (user.model.js)
import User from "../models/user.model.js";
import { sendEmail } from "../utils/sendEmail.js";

/**
 * Helper: construir base URL para los links de verificación.
 * Prefiere process.env.BASE_URL (si la defines), sino usa el origin de la petición,
 * y como último recurso reconstruye con protocolo + host.
 */
const getBaseUrlFromReq = (req) => {
  const fromEnv = (process.env.BASE_URL || "").replace(/\/+$/, "");
  if (fromEnv) return fromEnv;
  if (req.get && req.get("origin")) return req.get("origin").replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`.replace(/\/+$/, "");
};

/**
 * Environment toggles:
 * - AUTO_VERIFY=true  -> marca usuarios verificados automáticamente al registrarse (testing)
 * - ENFORCE_EMAIL_VERIFICATION=true -> exige verificación antes de permitir login (production)
 *
 * Nota: por seguridad activa ENFORCE_EMAIL_VERIFICATION en producción.
 */
const AUTO_VERIFY = String(process.env.AUTO_VERIFY || "").toLowerCase() === "true";
const ENFORCE_EMAIL_VERIFICATION = String(process.env.ENFORCE_EMAIL_VERIFICATION || "").toLowerCase() === "true";

/**
 * Normalizar campos (acepta typos comunes del frontend)
 */
const extractAddress = (body) => {
  return (body.address || body.adress || body.direccion || "").toString().trim();
};
const extractPhone = (body) => {
  return (body.phone || body.telefono || "").toString().trim();
};

// ============================
// REGISTER
// ============================
export const registerUser = async (req, res) => {
  try {
    // extraer campos; aceptamos 'adress' por compatibilidad con front
    let name = (req.body.name || req.body.fullname || "").toString().trim();
    let email = (req.body.email || "").toString().toLowerCase().trim();
    let password = req.body.password || req.body.pass || "";
    let phone = extractPhone(req.body);
    let address = extractAddress(req.body);

    // validaciones básicas (pero tolerantes)
    if (!name || !email || !password) {
      return res.status(400).json({ msg: "Nombre, correo y contraseña son obligatorios" });
    }

    // formato email simple
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ msg: "Correo inválido" });
    }

    // verificar si existe email
    const exists = await User.findOne({ email });
    if (exists) {
      return res.status(400).json({ msg: "Correo ya registrado" });
    }

    // hashear contraseña
    const hash = await bcrypt.hash(password, 10);
    const token = crypto.randomBytes(32).toString("hex");

    // crear usuario: incluimos address/phone solo si vienen (no romper schema)
    const payload = {
      name,
      email,
      password: hash,
      verified: false,
      verificationToken: token
    };
    if (phone) payload.phone = phone;
    if (address) payload.address = address;

    const user = await User.create(payload);

    // Si AUTO_VERIFY está activo (útil para pruebas), marcamos verificado
    let autoVerified = false;
    if (AUTO_VERIFY) {
      user.verified = true;
      user.verificationToken = null;
      await user.save();
      autoVerified = true;
      console.log(`[AUTH] AUTO_VERIFY active: user ${email} auto-verified.`);
    }

    // enlace de verificación (asegura que base no tenga slash al final)
    const base = getBaseUrlFromReq(req);
    const link = `${base}/api/verify/email/${token}`;

    // enviar correo (si falla, no borramos usuario; solo registramos en logs y devolvemos flag)
    let mailSent = false;
    let mailErrorMsg = null;
    if (!autoVerified) {
      try {
        console.log(`[MAIL] Intentando enviar correo de verificación a: ${email}`);
        console.log(`[MAIL] Link de verificación: ${link}`);

        await sendEmail(
          email,
          "Confirma tu cuenta - Leones Broker",
          `
            <h2>Bienvenido a Leones Broker</h2>
            <p>Gracias por registrarte, ${name}.</p>
            <p>Haz clic en el siguiente enlace para confirmar tu correo:</p>
            <p><a href="${link}">${link}</a></p>
            <p>Si no solicitaste este registro, ignora este correo.</p>
          `
        );

        console.log(`[MAIL] Enviado OK a ${email}`);
        mailSent = true;
      } catch (mailErr) {
        console.error("[MAIL] sendEmail error:", mailErr && (mailErr.message || mailErr));
        mailErrorMsg = (mailErr && (mailErr.message || String(mailErr))) || "Error al enviar email";
        // mailSent queda false; usuario sigue creado con verificationToken para verificar después
      }
    } else {
      // autoVerified => no intentamos enviar correo, pero marcamos verificationSent = true por UX
      mailSent = true;
      mailErrorMsg = null;
    }

    // responder sin exponer campos sensibles
    return res.status(201).json({
      msg: "Registro exitoso. Revisa tu correo para verificar la cuenta.",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone || "",
        address: user.address || ""
      },
      verificationSent: mailSent,
      mailError: mailSent ? null : mailErrorMsg,
      autoVerified
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

    // si hay clave duplicada por índice único (email), devolver 400 con mensaje claro
    if (error && error.code === 11000) {
      return res.status(400).json({ msg: "Correo ya registrado" });
    }

    return res.status(500).json({ msg: "Error del servidor" });
  }
};

// ============================
// RESEND VERIFICATION (UTIL)
// ============================
export const resendVerification = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ msg: "Email requerido" });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ msg: "Usuario no encontrado" });
    if (user.verified) return res.status(400).json({ msg: "Cuenta ya verificada" });

    // generar un nuevo token y guardar
    const token = crypto.randomBytes(32).toString("hex");
    user.verificationToken = token;
    await user.save();

    const base = getBaseUrlFromReq(req);
    const link = `${base}/api/verify/email/${token}`;

    try {
      console.log(`[MAIL] Reenviando verificación a ${email}`);
      await sendEmail(
        email,
        "Reenvío: Confirma tu cuenta - Leones Broker",
        `
          <h2>Leones Broker - Reenvío de verificación</h2>
          <p>Haz clic en el siguiente enlace para confirmar tu correo:</p>
          <p><a href="${link}">${link}</a></p>
        `
      );
      return res.json({ msg: "Email de verificación reenviado", verificationSent: true });
    } catch (mailErr) {
      console.error("[MAIL] resend sendEmail error:", mailErr && (mailErr.message || mailErr));
      return res.status(500).json({ msg: "No se pudo enviar el email de verificación", verificationSent: false, mailError: mailErr?.message || String(mailErr) });
    }

  } catch (err) {
    console.error("Error resendVerification:", err);
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

    const valid = await bcrypt.compare(password, user.password);
    if (!valid)
      return res.status(400).json({ msg: "Credenciales inválidas" });

    // Si ENFORCE_EMAIL_VERIFICATION está activo -> bloquear login si no verificado
    if (ENFORCE_EMAIL_VERIFICATION && !user.verified) {
      return res.status(401).json({ msg: "Correo no verificado", verificationRequired: true });
    }

    // Generar token JWT
    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET || "dev_jwt_secret",
      { expiresIn: "7d" }
    );

    // Devolver token y datos básicos del usuario (sin password ni verificationToken)
    // Incluimos flag 'verified' para que el frontend muestre mensaje si es necesario.
    return res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        balance: user.balance ?? 0,
        phone: user.phone || "",
        address: user.address || "",
        verified: !!user.verified
      },
      verified: !!user.verified,
      verificationRequired: !!ENFORCE_EMAIL_VERIFICATION
    });

  } catch (error) {
    console.error("Error login:", error);
    return res.status(500).json({ msg: "Error del servidor" });
  }
};
