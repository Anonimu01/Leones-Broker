// utils/sendEmail.js
import nodemailer from "nodemailer";
import { Resend } from "resend";

const {
  RESEND_API_KEY,
  SENDER_EMAIL,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  EMAIL_USER,
  EMAIL_PASS,
  NODE_ENV,
} = process.env;

/*
  Smart mailer:
  Priority:
   1) Resend (if RESEND_API_KEY)
   2) SMTP (if SMTP_HOST/SMTP_USER/SMTP_PASS or EMAIL_USER/EMAIL_PASS)
   3) Simulated (logs) - does not throw to avoid breaking flows

  sendEmail supports two call styles:
   - sendEmail(to, subject, htmlOrText)
   - sendEmail({ to, subject, html, text, from })
*/

const DEFAULT_SENDER = SENDER_EMAIL || SMTP_USER || EMAIL_USER || `no-reply@${process.env.BASE_URL?.replace(/https?:\/\//, "") || "local"}`;

let resendClient = null;
let transporter = null;
let transporterReady = false;

/* ---------- Init Resend (if configured) ---------- */
if (RESEND_API_KEY) {
  try {
    resendClient = new Resend(RESEND_API_KEY);
    console.log("[MAIL] ✅ Resend client inicializado");
  } catch (err) {
    console.error("[MAIL] ❌ Error inicializando Resend:", err && err.message ? err.message : err);
    resendClient = null;
  }
}

/* ---------- Init SMTP transporter (if Resend not present) ---------- */
const initSmtp = () => {
  if (transporter || (!SMTP_HOST && !SMTP_USER && !EMAIL_USER)) return;

  const host = SMTP_HOST || process.env.EMAIL_HOST || "smtp.gmail.com";
  const port = Number(SMTP_PORT || 465);
  const secure = (SMTP_SECURE || "true").toLowerCase() === "true" || port === 465;
  const user = SMTP_USER || EMAIL_USER;
  const pass = SMTP_PASS || EMAIL_PASS;

  if (!user || !pass) {
    console.warn("[MAIL] ⚠️ SMTP credenciales no encontradas; SMTP no se inicializa");
    return;
  }

  try {
    transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user,
        pass,
      },
      // aumenta timeouts razonables
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });

    // verify async but non-blocking
    transporter.verify((err, success) => {
      if (err) {
        transporterReady = false;
        console.error("[MAIL] ❌ SMTP verify failed:", err && err.message ? err.message : err);
        // keep transporter null to avoid attempts later if verify fails badly
        transporter = null;
      } else {
        transporterReady = true;
        console.log("[MAIL] ✅ SMTP transporter verificado y listo");
      }
    });
  } catch (err) {
    transporter = null;
    transporterReady = false;
    console.error("[MAIL] ❌ Error creando transporter SMTP:", err && err.message ? err.message : err);
  }
};

// initialize smtp if needed
if (!resendClient) initSmtp();

/* ---------- Helpers ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

function normalizeRecipients(to) {
  if (!to) return [];
  if (Array.isArray(to)) return to.map(String);
  if (typeof to === "string") return [to];
  if (typeof to === "object" && to.email) return [String(to.email)];
  return [String(to)];
}

/* ====================================================== */
/* Exported function - supports both signatures described  */
/* ====================================================== */
export const sendEmail = async (...args) => {
  // support sendEmail({ to, subject, html, text, from }) and sendEmail(to, subject, html)
  let payload = {};
  if (args.length === 1 && typeof args[0] === "object") {
    payload = { ...args[0] };
  } else {
    payload = {
      to: args[0],
      subject: args[1],
      html: args[2],
    };
  }

  const toArr = normalizeRecipients(payload.to);
  if (!toArr.length) {
    console.warn("[MAIL] destinatario vacío — skip");
    return { ok: false, skipped: true, reason: "empty_recipient" };
  }

  const subject = payload.subject || "Notificación";
  const html = payload.html || payload.body || "";
  const text = payload.text || (html ? html.replace(/<[^>]+>/g, "") : "");
  const from = payload.from || DEFAULT_SENDER;

  // Prefer Resend
  if (resendClient) {
    if (!from) {
      console.error("[MAIL] Resend configurado pero falta SENDER_EMAIL (from)");
      return { ok: false, provider: "resend", error: "missing_sender_email" };
    }

    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[MAIL] (resend) intento ${attempt} →`, toArr);
        const resp = await withTimeout(
          resendClient.emails.send({
            from,
            to: toArr,
            subject,
            html,
            text,
          }),
          12_000
        );
        console.log("[MAIL] ✅ Enviado via Resend:", resp?.id || resp);
        return { ok: true, provider: "resend", id: resp?.id || null, resp };
      } catch (err) {
        lastErr = err;
        console.error(`[MAIL] Resend fallo (int ${attempt}):`, err && err.message ? err.message : err);
        await sleep(400 * attempt);
      }
    }
    return { ok: false, provider: "resend", error: (lastErr && lastErr.message) ? lastErr.message : String(lastErr) };
  }

  // Fallback SMTP
  if (!transporter && (SMTP_HOST || SMTP_USER || EMAIL_USER)) {
    initSmtp();
  }

  if (transporter) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[MAIL] (smtp) intento ${attempt} →`, toArr);
        const info = await withTimeout(
          transporter.sendMail({
            from: `"Leones Broker" <${from}>`,
            to: toArr.join(","),
            subject,
            text,
            html,
          }),
          15_000
        );
        console.log("[MAIL] ✅ Enviado via SMTP:", info.messageId || info);
        return { ok: true, provider: "smtp", messageId: info.messageId || null, info };
      } catch (err) {
        lastErr = err;
        console.error(`[MAIL] SMTP fallo (int ${attempt}):`, err && err.message ? err.message : err);
        await sleep(400 * attempt);
      }
    }
    return { ok: false, provider: "smtp", error: (lastErr && lastErr.message) ? lastErr.message : String(lastErr) };
  }

  // No provider — simulate (non-fatal)
  console.warn("[MAIL] ⚠️ Ningún proveedor configurado. Envío simulado. (set RESEND_API_KEY or SMTP_* vars)");
  console.log("[MAIL] Simulado → to:", toArr, "subject:", subject, "from:", from);
  // Keep ok=true so flows that create users don't fail; mark simulated.
  return { ok: true, provider: "simulated", simulated: true, to: toArr, subject, from };
};

export default sendEmail;
