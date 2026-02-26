// controllers/auth.controller.js

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import User from "../models/user.model.js";
import { sendEmail } from "../utils/sendEmail.js";

/* =========================================================
   HELPERS / CONFIG
========================================================= */

const getBaseUrlFromReq = (req) => {
  if (process.env.BASE_URL)
    return process.env.BASE_URL.replace(/\/+$/, "");

  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");

  return `${protocol}://${host}`;
};

// robust parsing with defaults
const AUTO_VERIFY = String(process.env.AUTO_VERIFY || "false").toLowerCase() === "true";
const ENFORCE_EMAIL_VERIFICATION = String(process.env.ENFORCE_EMAIL_VERIFICATION || "false").toLowerCase() === "true";
const DEFAULT_LEVERAGE = process.env.DEFAULT_LEVERAGE ? Number(process.env.DEFAULT_LEVERAGE) : null;

const extractAddress = (body) =>
  (body.address || body.adress || body.dir || "").toString().trim();

const extractPhone = (body) =>
  (body.phone || body.tel || body.mobile || "").toString().trim();

function publicUser(user){
  // return a safe public view of user
  if(!user) return null;
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    verified: !!user.verified,
    phone: user.phone || '',
    address: user.address || '',
    balance: (typeof user.balance === 'number' ? user.balance : 0),
    leverage: (typeof user.leverage !== 'undefined' ? user.leverage : DEFAULT_LEVERAGE)
  };
}

/* =========================================================
   REGISTER
========================================================= */

export const registerUser = async (req, res) => {
  try {

    let name = (req.body.name || "").toString().trim();
    let email = (req.body.email || "").toLowerCase().trim();
    let password = (req.body.password || "").toString();
    let phone = extractPhone(req.body);
    let address = extractAddress(req.body);

    if (!name || !email || !password || !phone || !address)
      return res.status(400).json({ msg: "Faltan campos obligatorios" });

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ msg: "Email inválido" });

    const exists = await User.findOne({ email });
    if (exists)
      return res.status(409).json({ msg: "Correo ya registrado" });

    const hash = await bcrypt.hash(password, 12);
    const verificationToken = AUTO_VERIFY ? null : crypto.randomBytes(32).toString("hex");

    // create user with sensible defaults (balance 0)
    const user = await User.create({
      name,
      email,
      password: hash,
      phone,
      address,
      verified: !!AUTO_VERIFY,
      verificationToken: verificationToken,
      balance: 0,
      leverage: DEFAULT_LEVERAGE
    });

    /* ---------- EMAIL ---------- */

    let mailSent = false;
    let mailError = null;

    if (!AUTO_VERIFY && verificationToken) {
      try {
        const link = `${getBaseUrlFromReq(req)}/api/verify/email/${verificationToken}`;

        await sendEmail(
          email,
          "Verifica tu cuenta",
          `
            <h2>Bienvenido ${name}</h2>
            <p>Haz clic para verificar tu cuenta en Leones Broker:</p>
            <p><a href="${link}">${link}</a></p>
            <p>Si no solicitaste esto, ignora este correo.</p>
          `
        );

        mailSent = true;
      } catch (err) {
        mailError = (err && err.message) ? err.message : String(err);
        console.error("MAIL ERROR:", err);
        // dejamos verificationToken en BD para que el usuario pueda reenviarlo luego
      }
    }

    return res.status(201).json({
      msg: "Registro exitoso",
      verificationSent: mailSent,
      mailError,
      user: publicUser(user)
    });

  } catch (error) {
    console.error("REGISTER ERROR:", error);

    if (error.code === 11000)
      return res.status(409).json({ msg: "Correo ya registrado" });

    res.status(500).json({ msg: "Error del servidor" });
  }
};


/* =========================================================
   VERIFY EMAIL (link clickeado por el usuario)
   GET /api/verify/email/:token
========================================================= */

export const verifyEmail = async (req, res) => {
  try {
    const token = req.params.token;
    if (!token) return res.status(400).json({ msg: "Token inválido" });

    const user = await User.findOne({ verificationToken: token });
    if (!user) return res.status(404).json({ msg: "Token no válido o usuario no encontrado" });

    if (user.verified) {
      // already verified
      user.verificationToken = null;
      await user.save().catch(()=>{});
      return res.json({ msg: "Cuenta ya verificada" });
    }

    user.verified = true;
    user.verificationToken = null;
    await user.save();

    return res.json({ msg: "Cuenta verificada correctamente" });
  } catch (err) {
    console.error("VERIFY EMAIL ERROR:", err);
    return res.status(500).json({ msg: "Error del servidor" });
  }
};


/* =========================================================
   RESEND VERIFICATION
   POST /api/auth/resend-verification
========================================================= */

export const resendVerification = async (req, res) => {
  try {

    const email = (req.body.email || "").toLowerCase().trim();
    if (!email) return res.status(400).json({ msg: "Email requerido" });

    const user = await User.findOne({ email });
    if (!user)
      return res.status(404).json({ msg: "Usuario no encontrado" });

    if (user.verified)
      return res.status(400).json({ msg: "Cuenta ya verificada" });

    const token = crypto.randomBytes(32).toString("hex");
    user.verificationToken = token;
    await user.save();

    const link = `${getBaseUrlFromReq(req)}/api/verify/email/${token}`;

    let mailError = null;
    let mailSent = false;
    try {
      await sendEmail(
        email,
        "Reenvío verificación - Leones Broker",
        `<p>Haz clic para verificar tu cuenta: <a href="${link}">${link}</a></p>`
      );
      mailSent = true;
    } catch (err) {
      mailError = (err && err.message) ? err.message : String(err);
      console.error("RESEND MAIL ERROR:", err);
    }

    return res.json({ msg: "Operación completada", verificationSent: mailSent, mailError });

  } catch (err) {
    console.error("RESEND ERROR:", err);
    res.status(500).json({ msg: "Error del servidor" });
  }
};


/* =========================================================
   LOGIN
   POST /api/auth/login
========================================================= */

export const loginUser = async (req, res) => {
  try {

    let { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ msg: "Datos incompletos" });

    email = email.toLowerCase().trim();
    password = password.toString();

    const user = await User.findOne({ email });
    if (!user)
      return res.status(401).json({ msg: "Credenciales inválidas" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid)
      return res.status(401).json({ msg: "Credenciales inválidas" });

    if (ENFORCE_EMAIL_VERIFICATION && !user.verified)
      return res.status(403).json({
        msg: "Debes verificar tu correo",
        verificationRequired: true
      });

    if (!process.env.JWT_SECRET)
      throw new Error("JWT_SECRET no definido en entorno");

    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      token,
      user: publicUser(user)
    });

  } catch (error) {
    console.error("LOGIN ERROR:", error);
    res.status(500).json({ msg: "Error del servidor" });
  }
};


/* =========================================================
   GET PROFILE (verificar token desde frontend)
   GET /api/auth/me  (o /api/users/me)
========================================================= */

export const getProfile = async (req, res) => {
  try {
    // soporte Authorization Bearer y cookie "token"
    let token = null;
    const auth = req.headers.authorization || req.get('authorization') || '';
    if (auth && auth.toLowerCase().startsWith('bearer ')) token = auth.split(' ')[1];
    if (!token && req.cookies && req.cookies.token) token = req.cookies.token;
    if (!token) return res.status(401).json({ msg: "Token requerido" });

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(payload.id);
      if (!user) return res.status(404).json({ msg: "Usuario no encontrado" });
      return res.json({ user: publicUser(user) });
    } catch (err) {
      return res.status(401).json({ msg: "Token inválido" });
    }
  } catch (err) {
    console.error("GET PROFILE ERROR:", err);
    res.status(500).json({ msg: "Error del servidor" });
  }
};
