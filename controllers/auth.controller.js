// controllers/auth.controller.js
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import User from "../models/user.model.js";
import { sendEmail } from "../utils/sendEmail.js";

const getBaseUrlFromReq = (req) => {
  const fromEnv = (process.env.BASE_URL || "").replace(/\/+$/, "");
  if (fromEnv) return fromEnv;
  if (req.get && req.get("origin")) return req.get("origin").replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`.replace(/\/+$/, "");
};

const AUTO_VERIFY = String(process.env.AUTO_VERIFY || "").toLowerCase() === "true";
const ENFORCE_EMAIL_VERIFICATION = String(process.env.ENFORCE_EMAIL_VERIFICATION || "").toLowerCase() === "true";

const extractAddress = (body) => {
  return (body.address || body.adress || body.direccion || body.dir || "").toString().trim();
};
const extractPhone = (body) => {
  return (body.phone || body.telefono || body.tel || body.mobile || "").toString().trim();
};

// ============================
// REGISTER
// ============================
export const registerUser = async (req, res) => {
  try {
    // aceptar múltiples variantes de campos enviados desde distintos frontends
    let name =
      (req.body.name ||
        req.body.fullname ||
        req.body.fullName ||
        req.body.username ||
        req.body.nombre ||
        req.body.nick ||
        "")
        .toString()
        .trim();

    let email = (req.body.email || req.body.mail || req.body.usernameEmail || "").toString().toLowerCase().trim();
    let password = req.body.password || req.body.pass || req.body.pwd || "";
    let phone = extractPhone(req.body);
    let address = extractAddress(req.body);

    // validaciones básicas
    if (!name || !email || !password) {
      return res.status(400).json({
        msg: "Nombre, correo y contraseña son obligatorios",
        missing: {
          name: !!name,
          email: !!email,
          password: !!password,
        },
      });
    }

    // validación simple de email
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ msg: "Correo inválido" });
    }

    // comprobar existencia (indice único en modelo)
    const exists = await User.findOne({ email }).lean();
    if (exists) {
      return res.status(409).json({ msg: "Correo ya registrado" });
    }

    // hashear contraseña
    const hash = await bcrypt.hash(password, 10);
    const token = crypto.randomBytes(32).toString("hex");

    const payload = {
      name,
      email,
      password: hash,
      verified: false,
      verificationToken: token,
    };
    if (phone) payload.phone = phone;
    if (address) payload.address = address;

    const user = await User.create(payload);

    // AUTO_VERIFY -> marcar verificado sin enviar mail
    let autoVerified = false;
    if (AUTO_VERIFY) {
      user.verified = true;
      user.verificationToken = null;
      await user.save();
      autoVerified = true;
      console.log(`[AUTH] AUTO_VERIFY active: user ${email} auto-verified.`);
    }

    const base = getBaseUrlFromReq(req);
    const link = `${base}/api/verify/email/${token}`;

    let mailSent = false;
    let mailErrorMsg = null;

    if (!autoVerified) {
      try {
        console.log(`[MAIL] Intentando enviar correo de verificación a: ${email}`);
        console.log(`[MAIL] Link de verificación: ${link}`);

        // sendEmail debe lanzar si no hay configuración; si no, devolverá ok
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
        // No eliminamos al usuario: permitimos verificación manual/re-envío
      }
    } else {
      // Si autoVerified, consideramos que no es necesario enviar correo
      mailSent = true;
      mailErrorMsg = null;
    }

    return res.status(201).json({
      msg: "Registro exitoso. Revisa tu correo para verificar la cuenta.",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone || "",
        address: user.address || "",
      },
      verificationSent: mailSent,
      mailError: mailSent ? null : mailErrorMsg,
      autoVerified,
    });
  } catch (error) {
    console.error("Error register:", error);

    if (error && error.name === "ValidationError" && error.errors) {
      const details = {};
      for (const key in error.errors) {
        details[key] = error.errors[key].message || error.errors[key].kind;
      }
      return res.status(400).json({ msg: "Validation error", errors: details });
    }

    if (error && error.code === 11000) {
      return res.status(409).json({ msg: "Correo ya registrado" });
    }

    return res.status(500).json({ msg: "Error del servidor" });
  }
};

// ============================
// RESEND VERIFICATION
// ============================
export const resendVerification = async (req, res) => {
  try {
    const { email: rawEmail } = req.body;
    const email = (rawEmail || "").toString().toLowerCase().trim();
    if (!email) return res.status(400).json({ msg: "Email requerido" });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ msg: "Usuario no encontrado" });
    if (user.verified) return res.status(400).json({ msg: "Cuenta ya verificada" });

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
      return res.status(500).json({
        msg: "No se pudo enviar el email de verificación",
        verificationSent: false,
        mailError: mailErr?.message || String(mailErr),
      });
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
    let { email: rawEmail, password } = req.body;

    if (!rawEmail || !password) return res.status(400).json({ msg: "Datos incompletos" });

    const email = String(rawEmail).toLowerCase().trim();

    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ msg: "Credenciales inválidas" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ msg: "Credenciales inválidas" });

    if (ENFORCE_EMAIL_VERIFICATION && !user.verified) {
      return res.status(401).json({ msg: "Correo no verificado", verificationRequired: true });
    }

    const token = jwt.sign(
      { id: user._id, email: user.email },
      process.env.JWT_SECRET || "dev_jwt_secret",
      { expiresIn: "7d" }
    );

    return res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        balance: user.balance ?? 0,
        phone: user.phone || "",
        address: user.address || "",
        verified: !!user.verified,
      },
      verified: !!user.verified,
      verificationRequired: !!ENFORCE_EMAIL_VERIFICATION,
    });
  } catch (error) {
    console.error("Error login:", error);
    return res.status(500).json({ msg: "Error del servidor" });
  }
};
