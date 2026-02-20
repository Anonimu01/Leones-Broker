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

const AUTO_VERIFY =
  String(process.env.AUTO_VERIFY || "").toLowerCase() === "true";

const ENFORCE_EMAIL_VERIFICATION =
  String(process.env.ENFORCE_EMAIL_VERIFICATION || "").toLowerCase() === "true";

const extractAddress = (body) => {
  return (body.address || body.adress || body.direccion || body.dir || "")
    .toString()
    .trim();
};

const extractPhone = (body) => {
  return (body.phone || body.telefono || body.tel || body.mobile || "")
    .toString()
    .trim();
};

/* =========================================================
   REGISTER
========================================================= */
export const registerUser = async (req, res) => {
  try {
    let name =
      (
        req.body.name ||
        req.body.fullname ||
        req.body.fullName ||
        req.body.username ||
        req.body.nombre ||
        req.body.nick ||
        ""
      )
        .toString()
        .trim();

    let email = (
      req.body.email ||
      req.body.mail ||
      req.body.usernameEmail ||
      ""
    )
      .toString()
      .toLowerCase()
      .trim();

    let password = req.body.password || req.body.pass || req.body.pwd || "";
    let phone = extractPhone(req.body);
    let address = extractAddress(req.body);

    if (!name || !email || !password) {
      return res.status(400).json({
        msg: "Nombre, correo y contraseña son obligatorios",
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ msg: "Correo inválido" });
    }

    const exists = await User.findOne({ email }).lean();
    if (exists) {
      return res.status(409).json({ msg: "Correo ya registrado" });
    }

    const hash = await bcrypt.hash(password, 10);
    const token = crypto.randomBytes(32).toString("hex");

    const user = await User.create({
      name,
      email,
      password: hash,
      verified: false,
      verificationToken: token,
      phone,
      address,
    });

    let autoVerified = false;

    if (AUTO_VERIFY) {
      user.verified = true;
      user.verificationToken = null;
      await user.save();
      autoVerified = true;
    }

    const base = getBaseUrlFromReq(req);
    const link = `${base}/api/verify/email/${token}`;

    let mailSent = false;
    let mailErrorMsg = null;

    if (!autoVerified) {
      try {
        await sendEmail(
          email,
          "Confirma tu cuenta - Leones Broker",
          `
            <h2>Bienvenido a Leones Broker</h2>
            <p>Hola ${name}</p>
            <p>Haz clic para verificar tu cuenta:</p>
            <a href="${link}">${link}</a>
          `
        );
        mailSent = true;
      } catch (err) {
        mailErrorMsg = err?.message || "Error enviando email";
      }
    } else {
      mailSent = true;
    }

    return res.status(201).json({
      msg: "Registro exitoso",
      verificationSent: mailSent,
      autoVerified,
      mailError: mailErrorMsg,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone || "",
        address: user.address || "",
      },
    });
  } catch (error) {
    console.error("REGISTER ERROR:", error);

    if (error.code === 11000)
      return res.status(409).json({ msg: "Correo ya registrado" });

    return res.status(500).json({ msg: "Error del servidor" });
  }
};

/* =========================================================
   RESEND VERIFICATION
========================================================= */
export const resendVerification = async (req, res) => {
  try {
    const email = (req.body.email || "").toLowerCase().trim();
    if (!email) return res.status(400).json({ msg: "Email requerido" });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ msg: "Usuario no encontrado" });

    if (user.verified)
      return res.status(400).json({ msg: "Cuenta ya verificada" });

    const token = crypto.randomBytes(32).toString("hex");
    user.verificationToken = token;
    await user.save();

    const link = `${getBaseUrlFromReq(req)}/api/verify/email/${token}`;

    await sendEmail(
      email,
      "Reenvío verificación - Leones Broker",
      `<a href="${link}">${link}</a>`
    );

    res.json({ msg: "Email reenviado" });
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

    const user = await User.findOne({ email });
    if (!user)
      return res.status(401).json({ msg: "Credenciales inválidas" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid)
      return res.status(401).json({ msg: "Credenciales inválidas" });

    if (ENFORCE_EMAIL_VERIFICATION && !user.verified) {
      return res.status(403).json({
        msg: "Debes verificar tu correo antes de iniciar sesión",
        verificationRequired: true,
      });
    }

    const token = jwt.sign(
      { id: user._id },
      process.env.JWT_SECRET || "dev_secret",
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        verified: user.verified,
        phone: user.phone || "",
        address: user.address || "",
        balance: user.balance ?? 0,
      },
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    res.status(500).json({ msg: "Error del servidor" });
  }
};
