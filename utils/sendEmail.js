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

let transporter = null;

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
  if (typeof to === "object" && to.email) return [String(to.email)];
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

/* ---------- Resend via HTTP (no dependency) ---------- */
async function sendViaResendHTTP(from, toArr, subject, html, text) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY no configurado");

  const fetchFn = await getFetch();
  const body = {
    from,
    to: toArr,
    subject: subject || "(no subject)",
    html: html || "",
    // Resend accepts 'text' too, but many examples use html only
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

/* ---------- SMTP init & send ---------- */
function initSmtp() {
  if (transporter) return transporter;

  const host = SMTP_HOST || process.env.EMAIL_HOST || "smtp.gmail.com";
  const port = Number(SMTP_PORT || 465);
  const secure = (String(SMTP_SECURE || "").toLowerCase() === "true") || port === 465;
  const user = SMTP_USER || EMAIL_USER;
  const pass = SMTP_PASS || EMAIL_PASS;

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

    // try to verify but don't block startup
    transporter.verify()
      .then(() => console.log("[MAIL] ✅ SMTP transporter verificado"))
      .catch((err) => {
        console.error("[MAIL] ❌ SMTP verify failed:", err && err.message ? err.message : err);
        // leave transporter set so send attempts still try (they'll fail and be logged)
      });

    return transporter;
  } catch (err) {
    transporter = null;
    console.error("[MAIL] ❌ Error creando transporter SMTP:", err && err.message ? err.message : err);
    return null;
  }
}

async function sendViaSmtp(from, toArr, subject, html, text) {
  const tr = transporter || initSmtp();
  if (!tr) throw new Error("SMTP no configurado o fallo al inicializar transporter");
  const info = await withTimeout(
    tr.sendMail({
      from: `"Leones Broker" <${from}>`,
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
  const text = payload.text || (html ? String(html).replace(/<[^>]+>/g, "") : "");
  const from = payload.from || DEFAULT_SENDER;

  // 1) Try Resend (HTTP) if configured
  if (RESEND_API_KEY) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[MAIL] (resend-http) intento ${attempt} →`, toArr);
        const resp = await sendViaResendHTTP(from, toArr, subject, html, text);
        console.log("[MAIL] ✅ Enviado via Resend HTTP:", resp?.id || resp);
        return { ok: true, provider: "resend", id: resp?.id || null, resp };
      } catch (err) {
        lastErr = err;
        console.error(`[MAIL] Resend HTTP fallo (int ${attempt}):`, err && err.message ? err.message : err);
        await sleep(300 * attempt);
      }
    }
    // if Resend configured but failed, fall through to SMTP fallback
    console.warn("[MAIL] Resend configurado pero falló — intentando fallback SMTP");
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
  console.warn("[MAIL] ⚠️ Ningún proveedor configurado. Envío simulado. (set RESEND_API_KEY or SMTP_* vars)");
  console.log("[MAIL] Simulado → to:", toArr, "subject:", subject, "from:", from);
  return { ok: true, provider: "simulated", simulated: true, to: toArr, subject, from };
};

export default sendEmail;
