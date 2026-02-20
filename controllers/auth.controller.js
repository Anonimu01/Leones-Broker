// controllers/auth.controller.js

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import User from "../models/user.model.js";
import { sendEmail } from "../utils/sendEmail.js";

/* =========================================================
   HELPERS
========================================================= */

const getBaseUrlFromReq = (req) => {
  if (process.env.BASE_URL)
    return process.env.BASE_URL.replace(/\/+$/, "");

  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");

  return `${protocol}://${host}`;
};

const AUTO_VERIFY =
  String(process.env.AUTO_VERIFY).toLowerCase() === "true";

const ENFORCE_EMAIL_VERIFICATION =
  String(process.env.ENFORCE_EMAIL_VERIFICATION).toLowerCase() === "true";

const extractAddress = (body) =>
  (body.address || body.adress || body.dir || "").toString().trim();

const extractPhone = (body) =>
  (body.phone || body.tel || body.mobile || "").toString().trim();


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
    const verificationToken = crypto.randomBytes(32).toString("hex");

    const user = await User.create({
      name,
      email,
      password: hash,
      phone,
      address,
      verified: AUTO_VERIFY,
      verificationToken: AUTO_VERIFY ? null : verificationToken,
    });

    /* ---------- EMAIL ---------- */

    let mailSent = false;
    let mailError = null;

    if (!AUTO_VERIFY) {
      try {
        const link = `${getBaseUrlFromReq(req)}/api/verify/email/${verificationToken}`;

        await sendEmail(
          email,
          "Verifica tu cuenta",
          `
          <h2>Bienvenido ${name}</h2>
          <p>Haz clic para verificar:</p>
          <a href="${link}">${link}</a>
          `
        );

        mailSent = true;
      } catch (err) {
        mailError = err.message;
        console.error("MAIL ERROR:", err);
      }
    }

    return res.status(201).json({
      msg: "Registro exitoso",
      verificationSent: mailSent,
      mailError,
      user: {
        id: user._id,
        name: user.name,
        email: user.email
      }
    });

  } catch (error) {
    console.error("REGISTER ERROR:", error);

    if (error.code === 11000)
      return res.status(409).json({ msg: "Correo ya registrado" });

    res.status(500).json({ msg: "Error del servidor" });
  }
};


/* =========================================================
   RESEND VERIFICATION
========================================================= */

export const resendVerification = async (req, res) => {
  try {

    const email = (req.body.email || "").toLowerCase().trim();

    const user = await User.findOne({ email });
    if (!user)
      return res.status(404).json({ msg: "Usuario no encontrado" });

    if (user.verified)
      return res.status(400).json({ msg: "Cuenta ya verificada" });

    const token = crypto.randomBytes(32).toString("hex");
    user.verificationToken = token;
    await user.save();

    const link = `${getBaseUrlFromReq(req)}/api/verify/email/${token}`;

    await sendEmail(
      email,
      "Reenvío verificación",
      `<a href="${link}">Verificar cuenta</a>`
    );

    res.json({ msg: "Correo reenviado" });

  } catch (err) {
    console.error("RESEND ERROR:", err);
    res.status(500).json({ msg: "Error del servidor" });
  }
};


/* =========================================================
   LOGIN
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

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        verified: user.verified,
        phone: user.phone,
        address: user.address,
        balance: user.balance ?? 0
      }
    });

  } catch (error) {
    console.error("LOGIN ERROR:", error);
    res.status(500).json({ msg: "Error del servidor" });
  }
};
