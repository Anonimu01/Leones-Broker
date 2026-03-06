// utils/sendEmail.js
import nodemailer from "nodemailer";

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
  BASE_URL,
  NODE_ENV,
} = process.env;

const DEFAULT_SENDER =
  SENDER_EMAIL ||
  SMTP_USER ||
  EMAIL_USER ||
  `no-reply@${(BASE_URL || "local").replace(/^https?:\/\//, "")}`;

let resendClient = null;
let transporter = null;
let transporterReady = false;

/**
 * Try to dynamically import Resend (optional dependency).
 * If the package is not installed, we will silently continue without it.
 */
async function initResendClient() {
  if (!RESEND_API_KEY) return null;
  if (resendClient) return resendClient;
  try {
    // dynamic import to avoid hard dependency
    const mod = await import("resend");
    const Resend = mod?.Resend || mod?.default || mod;
    if (!Resend) throw new Error("Resend module loaded but Resend class not found");
    resendClient = new Resend(RESEND_API_KEY);
    console.log("[MAIL] ✅ Resend client inicializado");
    return resendClient;
  } catch (err) {
    console.warn("[MAIL] ⚠️ Resend no disponible (dynamic import falló):", err && err.message ? err.message : err);
    resendClient = null;
    return null;
  }
}

/**
 * Ensure a fetch implementation exists (Node 18+ has global fetch).
 * If not, try to dynamically import node-fetch.
 */
async function getFetch() {
  if (typeof globalThis.fetch === "function") return globalThis.fetch;
  try {
    const mod = await import("node-fetch");
    return mod.default || mod;
  } catch (err) {
    throw new Error("No fetch disponible en runtime y node-fetch no pudo importarse");
  }
}

/**
 * Init SMTP transporter (non-blocking verify)
 */
function initSmtp() {
  // if already set or no creds, do nothing
  if (transporter || (!SMTP_HOST && !SMTP_USER && !EMAIL_USER && !SMTP_PASS && !EMAIL_PASS)) return;

  const host = SMTP_HOST || process.env.EMAIL_HOST || "smtp.gmail.com";
  const port = Number(SMTP_PORT || 465);
  const secure = (String(SMTP_SECURE || "").toLowerCase() === "true") || port === 465;
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
      auth: { user, pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });

    transporter.verify((err, success) => {
      if (err) {
        transporterReady = false;
        console.error("[MAIL] ❌ SMTP verify failed:", err && err.message ? err.message : err);
        // keep transporter but mark not ready; attempts will still try and report errors
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
}

/* initialize smtp if resend not configured (best-effort) */
if (!RESEND_API_KEY) {
  initSmtp();
}

/* utility helpers */
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

/**
 * sendEmail(...)
 * Accepts:
 *  - sendEmail(to, subject, html)
 *  - sendEmail({ to, subject, html, text, from })
 *
 * Returns a consistent object:
 *  { ok: true, provider: 'resend'|'smtp'|'simulated', ... } or { ok:false, provider:..., error: '...' }
 */
export const sendEmail = async (...args) => {
  // normalize args
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
  const text = payload.text || (html ? String(html).replace(/<[^>]+>/g, "") : "");
  const from = payload.from || DEFAULT_SENDER;

  // Try Resend first (if configured)
  if (RESEND_API_KEY) {
    try {
      await initResendClient();
    } catch (e) {
      // initResendClient already logs; continue to fallback
    }

    if (resendClient) {
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(`[MAIL] (resend) intento ${attempt} →`, toArr);
          // The resend SDK may be async — use withTimeout to protect
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
    } else {
      console.warn("[MAIL] RESEND_API_KEY presente pero cliente Resend no inicializado, se usará fallback");
    }
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

  // No provider — simulate sending (non-fatal)
  console.warn("[MAIL] ⚠️ Ningún proveedor configurado. Envío simulado. (set RESEND_API_KEY or SMTP_* vars)");
  console.log("[MAIL] Simulado → to:", toArr, "subject:", subject, "from:", from);
  // In development keep simulated ok=true to not block flows; in production maybe return ok:false — keep ok:true for compatibility
  return { ok: true, provider: "simulated", simulated: true, to: toArr, subject, from };
};

export default sendEmail;
