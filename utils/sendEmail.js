// utils/sendEmail.js
/**
 * sendEmail helper (SOLO SMTP - Gmail recommended)
 *
 * - Usa exclusivamente SMTP (SMTP_* / MAIL_* env vars)
 * - No intenta Resend ni otros proveedores
 * - Devuelve un objeto claro { ok, provider, ... } o { ok:false, error }
 *
 * Required env vars (recommended):
 *  - SMTP_HOST (default: smtp.gmail.com)
 *  - SMTP_PORT (default: 465)
 *  - SMTP_SECURE (true/false) (default: true for port 465)
 *  - SMTP_USER
 *  - SMTP_PASS  (usar App Password en Gmail)
 *  - SENDER_EMAIL (opcional, por defecto SMTP_USER)
 *  - SENDER_NAME  (opcional)
 *
 * Usage:
 *  - sendEmail(to, subject, html)
 *  - sendEmail({ to, subject, html, text, from })
 */

import nodemailer from "nodemailer";

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  MAIL_HOST,
  MAIL_PORT,
  EMAIL_USER,
  EMAIL_PASS,
  SENDER_EMAIL,
  SENDER_NAME,
} = process.env;

const DEFAULT_SMTP_USER = SMTP_USER || EMAIL_USER;
const DEFAULT_SMTP_PASS = SMTP_PASS || EMAIL_PASS;

const DEFAULT_SENDER =
  (SENDER_EMAIL && String(SENDER_EMAIL).trim()) ||
  (DEFAULT_SMTP_USER ? `"${SENDER_NAME || "Leones Broker"}" <${DEFAULT_SMTP_USER}>` : null);

let transporter = null;

/* ---------- helpers ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withTimeout(promise, ms = 15000) {
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
  if (typeof to === "object" && (to.email || to.address)) return [String(to.email || to.address)];
  return [String(to)];
}

function buildFromHeader(fromRaw) {
  if (!fromRaw) return DEFAULT_SENDER || (DEFAULT_SMTP_USER ? `"Leones Broker" <${DEFAULT_SMTP_USER}>` : null);
  const s = String(fromRaw).trim();
  // if already in "Name <email@domain>" form, use as-is
  if (/<.+@.+>/.test(s) || /.+@.+\..+/.test(s)) return s;
  // otherwise try to build with SMTP user
  const emailOnlyMatch = s.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (emailOnlyMatch) return `"${SENDER_NAME || "Leones Broker"}" <${emailOnlyMatch[1]}>`;
  if (DEFAULT_SMTP_USER) return `"${SENDER_NAME || "Leones Broker"}" <${DEFAULT_SMTP_USER}>`;
  return s;
}

/* ---------- init SMTP transporter ---------- */
function initSmtp() {
  if (transporter) return transporter;

  const host = SMTP_HOST || MAIL_HOST || "smtp.gmail.com";
  const port = Number(SMTP_PORT || MAIL_PORT || 465);
  const secure = (String(SMTP_SECURE || "true").toLowerCase() === "true") || port === 465;
  const user = DEFAULT_SMTP_USER;
  const pass = DEFAULT_SMTP_PASS;

  if (!user || !pass) {
    console.warn("[MAIL] ⚠️ SMTP not configured: missing credentials (SMTP_USER / SMTP_PASS or EMAIL_USER / EMAIL_PASS)");
    return null;
  }

  try {
    transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });

    // verify but don't block startup
    transporter.verify()
      .then(() => console.log("[MAIL] ✅ SMTP transporter verificado (SMTP activo)"))
      .catch((err) => {
        console.warn("[MAIL] ❌ SMTP verify failed (credentials may be wrong):", err && err.message ? err.message : err);
      });

    return transporter;
  } catch (err) {
    transporter = null;
    console.error("[MAIL] ❌ Error creando transporter SMTP:", err && err.message ? err.message : err);
    return null;
  }
}

/* ---------- send via smtp ---------- */
async function sendViaSmtp(fromRaw, toArr, subject, html, text) {
  const tr = transporter || initSmtp();
  if (!tr) throw new Error("SMTP_NOT_CONFIGURED");

  const fromHeader = buildFromHeader(fromRaw);

  const mailOptions = {
    from: fromHeader,
    to: toArr.join(","),
    subject: subject || "(no subject)",
    text: text || (html ? String(html).replace(/<[^>]+>/g, "") : ""),
    html: html || undefined,
  };

  // send with timeout
  const info = await withTimeout(tr.sendMail(mailOptions), 20_000);
  return info;
}

/* ====================================================== */
/* Exported function - supports signatures:                */
/*  - sendEmail({ to, subject, html, text, from })         */
/*  - sendEmail(to, subject, html)                        */
/* ====================================================== */
export const sendEmail = async (...args) => {
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
    return { ok: false, error: "empty_recipient" };
  }

  const subject = payload.subject || "Notificación";
  const html = payload.html || payload.body || "";
  const text = payload.text || (html ? String(html).replace(/<[^>]+>/g, "") : "");
  const from = payload.from || SENDER_EMAIL || DEFAULT_SENDER;

  // initialize SMTP
  if (!transporter) initSmtp();

  if (!transporter) {
    console.error("[MAIL] SMTP no configurado. Verifica SMTP_USER / SMTP_PASS en .env (usa App Password para Gmail).");
    return { ok: false, error: "smtp_not_configured" };
  }

  // attempt send (2 tries)
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`[MAIL] (smtp) intento ${attempt} →`, toArr);
      const info = await sendViaSmtp(from, toArr, subject, html, text);
      console.log("[MAIL] ✅ Enviado via SMTP:", info.messageId || info);
      return { ok: true, provider: "smtp", messageId: info.messageId || null, info };
    } catch (err) {
      lastErr = err;
      console.error(`[MAIL] SMTP fallo (int ${attempt}):`, err && err.message ? err.message : err);
      // short backoff
      await sleep(250 * attempt);
    }
  }

  return { ok: false, provider: "smtp", error: (lastErr && lastErr.message) ? lastErr.message : String(lastErr) };
};

export default sendEmail;
