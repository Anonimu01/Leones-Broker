// utils/sendEmail.js
/**
 * sendEmail helper (versión con Resend SDK + HTTP fallback + SMTP)
 * - Intenta Resend SDK si RESEND_API_KEY está configurado
 * - Si SDK falla, intenta Resend via HTTP (node-fetch)
 * - Si Resend falla o no está configurado, intenta SMTP (SMTP_* o MAIL_* env vars)
 * - Si no hay proveedor configurado, hace un envío simulado y devuelve ok:true (no-fatal)
 *
 * Notas:
 * - Maneja 'from' que ya venga en formato "Name <email@dominio>".
 * - Usa timeouts/ reintentos ligeros.
 */

import nodemailer from "nodemailer";
import { Resend } from "resend";

const {
  // Resend
  RESEND_API_KEY,

  // Preferred sender
  SENDER_EMAIL,
  SENDER_NAME,

  // SMTP (preferred names)
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,

  // Alternate SMTP names historically used in tu repo
  MAIL_HOST,
  MAIL_PORT,
  EMAIL_USER,
  EMAIL_PASS,

  // misc
  BASE_URL,
  NODE_ENV,
} = process.env;

// DEFAULT SENDER resolution (supports multiple env names)
const DEFAULT_SENDER =
  SENDER_EMAIL ||
  SMTP_USER ||
  EMAIL_USER ||
  MAIL_HOST // (rare) keep as fallback
  ||
  `no-reply@${(BASE_URL || "local").replace(/^https?:\/\//, "")}`;

let transporter = null;
let resendClient = null;

/* ---------- helpers ---------- */
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
  if (typeof to === "object" && (to.email || to.address)) return [String(to.email || to.address)];
  return [String(to)];
}

async function getFetch() {
  if (typeof globalThis.fetch === "function") return globalThis.fetch;
  try {
    const mod = await import("node-fetch");
    return mod.default || mod;
  } catch (err) {
    throw new Error("No fetch disponible en runtime y node-fetch no pudo importarse");
  }
}

/* ---------- Resend SDK (preferred) ---------- */
function initResendSDK() {
  if (!RESEND_API_KEY) return null;
  if (resendClient) return resendClient;
  try {
    resendClient = new Resend(RESEND_API_KEY);
    return resendClient;
  } catch (err) {
    resendClient = null;
    console.warn("[MAIL] Resend SDK init failed:", err && err.message ? err.message : err);
    return null;
  }
}

async function sendViaResendSDK(from, toArr, subject, html, text) {
  const client = initResendSDK();
  if (!client) throw new Error("RESEND_API_KEY no configurado o Resend SDK no disponible");

  // Resend SDK expects an object; it throws on error
  const payload = {
    from,
    to: toArr,
    subject: subject || "(no subject)",
    html: html || "",
    // text optional
    text: text || "",
  };

  // SDK call (no fetch response.ok check — SDK throws if fails)
  const resp = await withTimeout(client.emails.send(payload), 12_000);
  return resp;
}

/* ---------- Resend via HTTP (fallback if SDK unavailable) ---------- */
async function sendViaResendHTTP(from, toArr, subject, html, text) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY no configurado");

  const fetchFn = await getFetch();
  const body = {
    from,
    to: toArr,
    subject: subject || "(no subject)",
    html: html || "",
    text: text || "",
  };

  const resp = await withTimeout(
    fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    12_000
  );

  if (!resp.ok) {
    const txt = await resp.text().catch(() => null);
    const err = new Error(`Resend HTTP error ${resp.status}: ${txt || resp.statusText}`);
    err.status = resp.status;
    err.body = txt;
    throw err;
  }

  const json = await resp.json().catch(() => ({}));
  return json;
}

/* ---------- SMTP init & send (supports SMTP_* and MAIL_* env names) ---------- */
function initSmtp() {
  if (transporter) return transporter;

  const host = SMTP_HOST || MAIL_HOST || "smtp.gmail.com";
  const port = Number(SMTP_PORT || MAIL_PORT || 465);
  const secure = (String(SMTP_SECURE || "").toLowerCase() === "true") || port === 465;
  const user = SMTP_USER || EMAIL_USER || process.env.SMTP_USER;
  const pass = SMTP_PASS || EMAIL_PASS || process.env.SMTP_PASS;

  if (!user || !pass) {
    console.warn("[MAIL] ⚠️ SMTP credenciales no encontradas; SMTP no se inicializará");
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
      .then(() => console.log("[MAIL] ✅ SMTP transporter verificado"))
      .catch((err) => {
        console.warn("[MAIL] ❌ SMTP verify failed (will still try sends):", err && err.message ? err.message : err);
      });

    return transporter;
  } catch (err) {
    transporter = null;
    console.error("[MAIL] ❌ Error creando transporter SMTP:", err && err.message ? err.message : err);
    return null;
  }
}

async function sendViaSmtp(fromRaw, toArr, subject, html, text) {
  const tr = transporter || initSmtp();
  if (!tr) throw new Error("SMTP no configurado o fallo al inicializar transporter");

  // If 'fromRaw' already contains <email@domain> or a display name, use it as-is.
  // Otherwise try to build: "Leones Broker <email@domain>"
  let fromHeader = fromRaw;
  const hasAngle = typeof fromRaw === "string" && /<.*@.*>/.test(fromRaw);
  const hasQuotedName = typeof fromRaw === "string" && /^".+" <.+@.+>$/.test(fromRaw);
  if (!hasAngle && !hasQuotedName) {
    // extract only email if DEFAULT_SENDER contains a full form
    const emailOnlyMatch = String(fromRaw).match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    const emailOnly = emailOnlyMatch ? emailOnlyMatch[1] : String(fromRaw);
    const name = SENDER_NAME || "Leones Broker";
    fromHeader = `"${name}" <${emailOnly}>`;
  }

  const info = await withTimeout(
    tr.sendMail({
      from: fromHeader,
      to: toArr.join(","),
      subject,
      text,
      html,
    }),
    15_000
  );
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
    return { ok: false, skipped: true, reason: "empty_recipient" };
  }

  const subject = payload.subject || "Notificación";
  const html = payload.html || payload.body || "";
  const text = payload.text || (html ? String(html).replace(/<[^>]+>/g, "") : "");
  const from = payload.from || SENDER_EMAIL || DEFAULT_SENDER;

  // 1) Try Resend SDK if configured
  if (RESEND_API_KEY) {
    // Prefer the official SDK (if init succeeds), fallback to HTTP if SDK fails
    try {
      const sdk = initResendSDK();
      if (sdk) {
        let lastErr = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            console.log(`[MAIL] (resend-sdk) intento ${attempt} →`, toArr);
            const resp = await sendViaResendSDK(from, toArr, subject, html, text);
            console.log("[MAIL] ✅ Enviado via Resend SDK:", resp?.id || resp);
            return { ok: true, provider: "resend-sdk", id: resp?.id || null, resp };
          } catch (err) {
            lastErr = err;
            console.error(`[MAIL] Resend SDK fallo (int ${attempt}):`, err && err.message ? err.message : err);
            await sleep(300 * attempt);
          }
        }
        console.warn("[MAIL] Resend SDK configurado pero falló en todos los intentos:", (lastErr && lastErr.message) ? lastErr.message : lastErr);
        // fallthrough to HTTP fallback or SMTP
      } else {
        console.warn("[MAIL] Resend SDK no pudo inicializarse, intentando HTTP fallback");
      }
    } catch (e) {
      console.error("[MAIL] Error usando Resend SDK:", e && e.message ? e.message : e);
    }

    // 1b) If SDK failed or couldn't init, try HTTP fallback
    try {
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(`[MAIL] (resend-http) intento ${attempt} →`, toArr);
          const resp = await sendViaResendHTTP(from, toArr, subject, html, text);
          console.log("[MAIL] ✅ Enviado via Resend HTTP:", resp?.id || resp);
          return { ok: true, provider: "resend-http", id: resp?.id || null, resp };
        } catch (err) {
          lastErr = err;
          console.error(`[MAIL] Resend HTTP fallo (int ${attempt}):`, err && err.message ? err.message : err);
          await sleep(300 * attempt);
        }
      }
      console.warn("[MAIL] Resend HTTP fallback falló en todos los intentos:", (lastErr && lastErr.message) ? lastErr.message : lastErr);
    } catch (e) {
      console.error("[MAIL] Error en Resend HTTP fallback:", e && e.message ? e.message : e);
    }

    console.warn("[MAIL] Resend configurado pero no pudo enviar — intentando fallback SMTP");
  }

  // 2) Try SMTP if available
  if (!transporter) initSmtp();

  if (transporter) {
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
        await sleep(300 * attempt);
      }
    }
    return { ok: false, provider: "smtp", error: (lastErr && lastErr.message) ? lastErr.message : String(lastErr) };
  }

  // 3) No provider configured => simulate (non-fatal)
  console.warn("[MAIL] ⚠️ Ningún proveedor configurado. Envío simulado. (set RESEND_API_KEY or SMTP_* / MAIL_* vars)");
  console.log("[MAIL] Simulado → to:", toArr, "subject:", subject, "from:", from);
  return { ok: true, provider: "simulated", simulated: true, to: toArr, subject, from };
};

export default sendEmail;
