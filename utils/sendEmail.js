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
 Strategy:
 - Si RESEND_API_KEY existe → usar Resend (producción)
 - Si no → usar Nodemailer (dev local)
*/

let resendClient = null;

if (RESEND_API_KEY) {
  try {
    resendClient = new Resend(RESEND_API_KEY);
    console.log("✅ Resend cliente inicializado.");
  } catch (err) {
    console.error("❌ Error inicializando Resend:", err);
  }
}

let transporter = null;

if (!resendClient) {
  if (!EMAIL_USER || !EMAIL_PASS) {
    console.warn("⚠️ No hay credenciales SMTP para fallback.");
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

    transporter.verify((err) => {
      if (err) console.error("SMTP error:", err);
      else console.log("✅ SMTP listo");
    });
  }
}

export const sendEmail = async (to, subject, html) => {

  if (!to) throw new Error("Missing 'to'");
  if (!subject) throw new Error("Missing 'subject'");

  // ---------- RESEND ----------
  if (resendClient) {
    if (!SENDER_EMAIL)
      throw new Error("SENDER_EMAIL no definido");

    try {
      console.log("[MAIL] usando Resend");

      const resp = await resendClient.emails.send({
        from: SENDER_EMAIL,
        to: Array.isArray(to) ? to : [to],
        subject,
        html
      });

      console.log("Email enviado:", resp?.id);
      return resp;

    } catch (err) {
      console.error("Resend error:", err);
      throw err;
    }
  }

  // ---------- SMTP fallback ----------
  if (!transporter)
    throw new Error("No email provider configurado");

  const info = await transporter.sendMail({
    from: `"Leones Broker" <${EMAIL_USER}>`,
    to,
    subject,
    html
  });

  return info;
};
