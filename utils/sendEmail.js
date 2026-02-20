// utils/sendEmail.js
import nodemailer from "nodemailer";
import { Resend } from "resend";

const {
  RESEND_API_KEY,
  SENDER_EMAIL,
  EMAIL_USER,
  EMAIL_PASS
} = process.env;

/*
  Sistema inteligente de envío:

  PRIORIDAD
  1) Resend (producción recomendado)
  2) SMTP (fallback dev/local)
  3) Log seguro (no rompe registro si no hay proveedor)

  Nunca lanza error fatal.
*/

let resendClient = null;
let transporter = null;

/* ---------- INIT RESEND ---------- */
if (RESEND_API_KEY) {
  try {
    resendClient = new Resend(RESEND_API_KEY);
    console.log("✅ Resend listo");
  } catch (err) {
    console.error("❌ Error iniciando Resend:", err.message);
  }
}

/* ---------- INIT SMTP ---------- */
if (!resendClient && EMAIL_USER && EMAIL_PASS) {
  try {
    transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS
      }
    });

    transporter.verify((err) => {
      if (err) console.error("❌ SMTP error:", err.message);
      else console.log("✅ SMTP listo");
    });

  } catch (err) {
    console.error("❌ Error creando transporter:", err.message);
  }
}

/* ====================================================== */

export const sendEmail = async (to, subject, html) => {

  if (!to) {
    console.warn("[MAIL] destinatario vacío");
    return { skipped: true };
  }

  if (!subject) subject = "Notificación";

  /* ---------- RESEND ---------- */
  if (resendClient) {
    if (!SENDER_EMAIL) {
      console.error("❌ Falta SENDER_EMAIL en variables entorno");
      return { skipped: true };
    }

    try {
      console.log("[MAIL] usando Resend →", to);

      const resp = await resendClient.emails.send({
        from: SENDER_EMAIL,
        to: Array.isArray(to) ? to : [to],
        subject,
        html
      });

      console.log("✅ Email enviado (Resend):", resp?.id);
      return resp;

    } catch (err) {
      console.error("❌ Resend fallo:", err.message);
      return { error: err.message };
    }
  }

  /* ---------- SMTP ---------- */
  if (transporter) {
    try {
      console.log("[MAIL] usando SMTP →", to);

      const info = await transporter.sendMail({
        from: `"Leones Broker" <${EMAIL_USER}>`,
        to,
        subject,
        html
      });

      console.log("✅ Email enviado SMTP:", info.messageId);
      return info;

    } catch (err) {
      console.error("❌ SMTP fallo:", err.message);
      return { error: err.message };
    }
  }

  /* ---------- SIN PROVEEDOR ---------- */
  console.warn("⚠️ No hay proveedor de email configurado");
  console.log("📧 Email simulado:");
  console.log("Para:", to);
  console.log("Asunto:", subject);

  return {
    simulated: true,
    to,
    subject
  };
};
