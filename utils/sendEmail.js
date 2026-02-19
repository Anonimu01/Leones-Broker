// utils/sendEmail.js
import nodemailer from "nodemailer";

const { EMAIL_USER, EMAIL_PASS } = process.env;

if (!EMAIL_USER || !EMAIL_PASS) {
  console.warn(
    "⚠️ EMAIL_USER o EMAIL_PASS no definidos en .env. El envío de emails fallará si no están configurados."
  );
}

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
  // opcional: aumenta timeouts si tu conexión es lenta
  // pool: true,
  // maxConnections: 5,
  // maxRetries: 3
});

// Verificar conexión SMTP al iniciar (útil para debug)
transporter.verify((err, success) => {
  if (err) {
    console.error("❌ SMTP verify error:", err);
  } else {
    console.log("✅ SMTP listo para enviar emails (transport verified).");
  }
});

/**
 * sendEmail
 * Lanza error si falla para que el caller (controller) lo capture.
 * Devuelve el objeto `info` de nodemailer en caso de éxito.
 */
export const sendEmail = async (to, subject, html) => {
  try {
    const info = await transporter.sendMail({
      from: `"Leones Broker" <${EMAIL_USER}>`,
      to,
      subject,
      html,
    });

    console.log("📧 Email enviado a", to, "messageId:", info?.messageId);
    return info;
  } catch (error) {
    // Log detallado en backend
    console.error("❌ Error enviando email:", error);
    // Re-throw para que el controller pueda detectarlo y responder adecuadamente
    const err = new Error(error?.message || "Error enviando email");
    err.original = error;
    throw err;
  }
};
