import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import User from "../models/user.model.js";
import { sendEmail } from "../utils/sendEmail.js";


// ============================
// REGISTER
// ============================
export const registerUser = async (req, res) => {
  try {
    let { name, email, password } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ msg: "Todos los campos son obligatorios" });

    email = email.toLowerCase().trim();

    const exists = await User.findOne({ email });
    if (exists)
      return res.status(400).json({ msg: "Correo ya registrado" });

    const hash = await bcrypt.hash(password, 10);
    const token = crypto.randomBytes(32).toString("hex");

    await User.create({
      name,
      email,
      password: hash,
      verificationToken: token
    });

    const link = `${process.env.BASE_URL}/api/verify/email/${token}`;

    await sendEmail(
      email,
      "Confirma tu cuenta",
      `
      <h2>Bienvenido a Leones Broker</h2>
      <p>Haz clic para confirmar tu correo:</p>
      <a href="${link}">${link}</a>
      `
    );

    res.json({ msg: "Registro exitoso. Revisa tu correo." });

  } catch (error) {
    console.error("Error register:", error);
    res.status(500).json({ msg: "Error del servidor" });
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

    email = email.toLowerCase().trim();

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

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        balance: user.balance
      }
    });

  } catch (error) {
    console.error("Error login:", error);
    res.status(500).json({ msg: "Error del servidor" });
  }
};
