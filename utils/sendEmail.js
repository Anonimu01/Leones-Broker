// utils/sendEmail.js
import nodemailer from "nodemailer";
import Resend from "resend";

const {
  RESEND_API_KEY,
  SENDER_EMAIL,
  EMAIL_USER,
  EMAIL_PASS
} = process.env;

/**
 * Strategy:
 * - Si RESEND_API_KEY está definido => usar Resend (producción, Render).
 * - Si no => fallback a Nodemailer (útil en dev local).
 *
 * Siempre lanza (throw) el error para que el controller lo capture.
 */

// Inicializar cliente Resend si hay API key
let resendClient = null;
if (RESEND_API_KEY) {
  try {
    resendClient = new Resend(RESEND_API_KEY);
    console.log("✅ Resend cliente inicializado.");
  } catch (err) {
    console.error("❌ Error inicializando Resend:", err);
    // no throw aquí para permitir fallback a nodemailer en dev
  }
}

// Preparar transporter nodemailer (fallback)
let transporter = null;
if (!resendClient) {
  if (!EMAIL_USER || !EMAIL_PASS) {
    console.warn("⚠️ EMAIL_USER o EMAIL_PASS no definidos. Nodemailer no estará disponible como fallback.");
  } else {
    transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS
      }
    });

    // verify transporter (solo en arranque)
    transporter.verify((err, success) => {
      if (err) {
        console.error("❌ Nodemailer verify error:", err);
      } else {
        console.log("✅ Nodemailer transporter listo (SMTP verified).");
      }
    });
  }
}

/**
 * sendEmail(to, subject, html)
 * - to: string or array
 * - subject: string
 * - html: string (HTML body)
 *
 * Lanza error si falla.
 */
export const sendEmail = async (to, subject, html) => {
  // Validaciones básicas
  if (!to) throw new Error("Missing 'to' in sendEmail");
  if (!subject) throw new Error("Missing 'subject' in sendEmail");
  if (!html) html = "";

  // 1) Usar Resend si está disponible
  if (resendClient) {
    if (!SENDER_EMAIL) {
      throw new Error("SENDER_EMAIL no definido (necesario para Resend).");
    }
    try {
      console.log(`[MAIL][Resend] Enviando a: ${to} - subject: ${subject}`);
      const resp = await resendClient.emails.send({
        from: SENDER_EMAIL,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
      });
      console.log("[MAIL][Resend] Enviado OK. id:", resp?.id);
      return resp;
    } catch (err) {
      console.error("[MAIL][Resend] Error enviando email:", err);
      // Re-throw para que el controller capture y responda adecuadamente
      const e = new Error(err?.message || "Resend send error");
      e.original = err;
      throw e;
    }
  }

  // 2) Fallback nodemailer
  if (!transporter) {
    throw new Error("No email transporter disponible (ni Resend ni Nodemailer configurados).");
  }

  try {
    console.log(`[MAIL][Nodemailer] Enviando a: ${to} - subject: ${subject}`);
    const info = await transporter.sendMail({
      from: `"Leones Broker" <${EMAIL_USER}>`,
      to,
      subject,
      html,
    });
    console.log("[MAIL][Nodemailer] Enviado OK. messageId:", info?.messageId);
    return info;
  } catch (err) {
    console.error("[MAIL][Nodemailer] Error enviando email:", err);
    const e = new Error(err?.message || "Nodemailer send error");
    e.original = err;
    throw e;
  }
};
