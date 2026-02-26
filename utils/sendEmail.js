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

  Nunca lanza error fatal; siempre retorna un objeto con estado.
*/

let resendClient = null;
let transporter = null;

/* ---------- INIT RESEND ---------- */
if (RESEND_API_KEY) {
  try {
    resendClient = new Resend(RESEND_API_KEY);
    console.log("✅ Resend listo");
  } catch (err) {
    console.error("❌ Error iniciando Resend:", err && err.message ? err.message : err);
    resendClient = null;
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
      if (err) {
        console.error("❌ SMTP error (verify):", err.message || err);
        transporter = null;
      } else {
        console.log("✅ SMTP listo");
      }
    });

  } catch (err) {
    console.error("❌ Error creando transporter:", err.message || err);
    transporter = null;
  }
}

/* small sleep util */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* timeout wrapper */
async function withTimeout(promise, ms = 10000) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error("timeout")), ms);
  });
  try {
    const res = await Promise.race([promise, timeout]);
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ====================================================== */

export const sendEmail = async (to, subject, html) => {
  if (!to) {
    console.warn("[MAIL] destinatario vacío");
    return { ok: false, skipped: true, reason: "empty_recipient" };
  }

  if (!subject) subject = "Notificación";

  // Normalize recipients
  const tos = Array.isArray(to) ? to : [String(to)];

  /* ---------- RESEND (preferido) ---------- */
  if (resendClient) {
    if (!SENDER_EMAIL) {
      console.error("❌ Falta SENDER_EMAIL en variables entorno (necesario para Resend)");
      return { ok: false, provider: "resend", error: "missing_sender_email" };
    }

    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[MAIL] (resend) intento ${attempt} →`, tos);
        const resp = await resendClient.emails.send({
          from: SENDER_EMAIL,
          to: tos,
          subject,
          html
        });
        console.log("✅ Email enviado (Resend):", resp?.id || resp);
        return { ok: true, provider: "resend", id: resp?.id || null, resp };
      } catch (err) {
        lastErr = err;
        console.error(`[MAIL] Resend fallo (intento ${attempt}):`, err && err.message ? err.message : err);
        // small backoff
        await sleep(400 * attempt);
      }
    }
    return { ok: false, provider: "resend", error: (lastErr && lastErr.message) ? lastErr.message : String(lastErr) };
  }

  /* ---------- SMTP (fallback) ---------- */
  if (transporter) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[MAIL] (smtp) intento ${attempt} →`, tos);
        const info = await withTimeout(transporter.sendMail({
          from: `"Leones Broker" <${EMAIL_USER}>`,
          to: tos.join(","),
          subject,
          html
        }), 12000); // 12s timeout
        console.log("✅ Email enviado SMTP:", info.messageId || info);
        return { ok: true, provider: "smtp", messageId: info.messageId || null, info };
      } catch (err) {
        lastErr = err;
        console.error(`[MAIL] SMTP fallo (intento ${attempt}):`, (err && err.message) ? err.message : err);
        await sleep(400 * attempt);
      }
    }
    return { ok: false, provider: "smtp", error: (lastErr && lastErr.message) ? lastErr.message : String(lastErr) };
  }

  /* ---------- SIN PROVEEDOR (simulado/log) ---------- */
  console.warn("⚠️ No hay proveedor de email configurado — simulando envío");
  console.log("📧 Email simulado → Para:", tos, "Asunto:", subject);
  // No lanzar: devolvemos ok=true pero marcado como simulado para que el flujo siga.
  return { ok: true, provider: "simulated", simulated: true, to: tos, subject };
};
