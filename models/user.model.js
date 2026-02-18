// controllers/auth.controller.js
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import User from "../models/user.model.js";
import { sendEmail } from "../utils/sendEmail.js";

/**
 * Helper: crea un objeto address a partir del body (acepta address object o campos sueltos).
 */
const buildAddress = (body) => {
  if (!body) return undefined;
  if (typeof body === "string" && body.trim()) return { street: body };
  // body puede ser un objeto con street, city, state, zip, country
  const { street, city, state, zip, country } = body;
  if (street || city || state || zip || country) {
    return { street, city, state, zip, country };
  }
  // campos individuales
  const streetF = body.street || body.addressStreet || "";
  if (streetF) return { street: streetF, city: body.city || "", state: body.state || "", zip: body.zip || "", country: body.country || "" };
  return undefined;
};

/**
 * REGISTER
 * Recibe: { name, email, password, phone, address, documents }
 * Guarda el usuario (hash password), crea verificationToken, intenta enviar email (no bloquea).
 * Responde: { msg, user }
 */
export const registerUser = async (req, res) => {
  try {
    let { name, email, password, phone, address, documents } = req.body;

    // Validación básica
    if (!name || !email || !password) {
      return res.status(400).json({ msg: "name, email y password son obligatorios" });
    }

    email = String(email).toLowerCase().trim();

    // Verificar duplicado
    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ msg: "Correo ya registrado" });

    // Hash password
    const hash = await bcrypt.hash(password, 10);

    // Token de verificación
    const token = crypto.randomBytes(32).toString("hex");

    // Preparar address y documents (si vienen)
    const addressObj = buildAddress(address);
    const docsArray = Array.isArray(documents) ? documents.map(d => ({ name: d.name || d.type || "document", url: d.url || d.path || "", type: d.type || "" })) : [];

    // Crear usuario
    const user = await User.create({
      name: String(name).trim(),
      email,
      phone: phone ? String(phone).trim() : "",
      password: hash,
      address: addressObj,
      documents: docsArray,
      verificationToken: token
    });

    // Intentar enviar correo (no bloquea el proceso si falla)
    (async () => {
      try {
        const link = `${process.env.BASE_URL}/api/verify/email/${token}`;
        await sendEmail(
          user.email,
          "Confirma tu cuenta",
          `
            <h2>Bienvenido a Leones Broker</h2>
            <p>Hola ${user.name}, por favor confirma tu correo haciendo clic en el siguiente enlace:</p>
            <a href="${link}">${link}</a>
            <p>Si no solicitaste esto, ignora este mensaje.</p>
          `
        );
        console.log("📧 Email de verificación enviado a", user.email);
      } catch (err) {
        // solo logueamos; no revertimos el registro
        console.error("❌ Error enviando email (no bloquea guardado):", err?.message || err);
      }
    })();

    // Enviar datos al CRM si está configurado (no bloquear)
    (async () => {
      try {
        if (process.env.CRM_URL) {
          const crmPayload = {
            name: user.name,
            email: user.email,
            phone: user.phone,
            address: user.address,
            documents: user.documents,
            createdAt: user.createdAt,
            userId: user._id
          };

          // Node moderno tiene fetch; si no lo tienes, instala axios o usa node-fetch.
          await fetch(process.env.CRM_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(crmPayload),
            // opcional: timeout via AbortController si quieres
          }).catch(e => console.error("CRM post failed:", e));
          console.log("➡️ Enviado a CRM (si configurado)");
        }
      } catch (e) {
        console.error("CRM error:", e);
      }
    })();

    // Responder con el usuario creado (toJSON del modelo elimina password/verificationToken)
    return res.status(201).json({ msg: "Registro exitoso. Revisa tu correo para verificar la cuenta.", user });

  } catch (err) {
    console.error("Error registerUser:", err);
    // Manejo duplicado de email (mongoose unique)
    if (err.code === 11000 && err.keyPattern && err.keyPattern.email) {
      return res.status(400).json({ msg: "El correo ya está registrado" });
    }
    return res.status(500).json({ msg: "Error del servidor" });
  }
};

/**
 * LOGIN
 * Recibe: { email, password }
 * Requiere que user.verified === true (si deseas permitir login antes, cambia esto)
 * Responde: { token, user }
 */
export const loginUser = async (req, res) => {
  try {
    let { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ msg: "Email y contraseña requeridos" });

    email = String(email).toLowerCase().trim();

    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ msg: "Credenciales inválidas" });

    // Verificación de cuenta
    if (!user.verified) return res.status(401).json({ msg: "Correo no verificado" });

    // Comparar contraseña
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ msg: "Credenciales inválidas" });

    // Firmar token
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });

    // Devolver token + user (user se transformará vía toJSON)
    return res.json({ token, user });
  } catch (err) {
    console.error("Error loginUser:", err);
    return res.status(500).json({ msg: "Error del servidor" });
  }
};
