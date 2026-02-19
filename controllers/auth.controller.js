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
  if (req.get("origin")) return req.get("origin").replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`.replace(/\/+$/, "");
};

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

    // Verificación simple de formato de correo (no sustituye validación avanzada)
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

    // enlace de verificación (asegura que base no tenga slash al final)
    const base = getBaseUrlFromReq(req);
    const link = `${base}/api/verify/email/${token}`;

    // enviar correo (si falla, no borramos usuario; solo registramos en logs y devolvemos flag)
    let mailSent = false;
    let mailErrorMsg = null;
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
      // Log detallado para debugging en backend (no exponemos stack entero al cliente)
      console.error("[MAIL] sendEmail error:", mailErr && (mailErr.message || mailErr));
      if (mailErr && mailErr.response) console.error("[MAIL] response:", mailErr.response);
      mailErrorMsg = (mailErr && (mailErr.message || String(mailErr))) || "Error al enviar email";
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
      verificationSent: mailSent,
      mailError: mailSent ? null : mailErrorMsg
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
// RESEND VERIFICATION (UTIL)
// ============================
// Permite re-enviar el email de verificación al usuario (sin crear nuevo usuario).
// Puedes montar esto en una ruta POST /api/auth/resend-verification
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
