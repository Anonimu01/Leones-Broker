// utils/sendEmail.js
/**
 * SMTP-only email helper for Leones Broker
 *
 * Usa exclusivamente SMTP.
 * Recomendado: Gmail con App Password.
 *
 * Env vars:
 *  - SMTP_HOST (default: smtp.gmail.com)
 *  - SMTP_PORT (default: 465)
 *  - SMTP_SECURE (default: true for 465)
 *  - SMTP_USER
 *  - SMTP_PASS
 *  - SENDER_NAME (default: Leones Broker)
 *
 * Opcionales:
 *  - MAIL_HOST / MAIL_PORT
 *  - EMAIL_USER / EMAIL_PASS
 *
 * Uso:
 *  - sendEmail({ to, subject, html, text })
 *  - sendEmail(to, subject, html)
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
  SENDER_NAME,
} = process.env;

const SMTP_USER_FINAL = SMTP_USER || EMAIL_USER || "";
const SMTP_PASS_FINAL = SMTP_PASS || EMAIL_PASS || "";

const DEFAULT_FROM_NAME = SENDER_NAME || "Leones Broker";

let transporter = null;
let transporterVerifyPromise = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeRecipients(to) {
  if (!to) return [];
  if (Array.isArray(to)) return to.map((x) => String(x).trim()).filter(Boolean);
  if (typeof to === "string") return [to.trim()].filter(Boolean);
  if (typeof to === "object" && (to.email || to.address)) {
    return [String(to.email || to.address).trim()].filter(Boolean);
  }
  return [String(to).trim()].filter(Boolean);
}

function buildFromHeader() {
  if (!SMTP_USER_FINAL) return null;
  return `"${DEFAULT_FROM_NAME}" <${SMTP_USER_FINAL}>`;
}

function initSmtp() {
  if (transporter) return transporter;

  const host = SMTP_HOST || MAIL_HOST || "smtp.gmail.com";
  const port = Number(SMTP_PORT || MAIL_PORT || 465);

  const secure =
    typeof SMTP_SECURE === "string"
      ? SMTP_SECURE.toLowerCase() === "true"
      : port === 465;

  if (!SMTP_USER_FINAL || !SMTP_PASS_FINAL) {
    console.warn(
      "[MAIL] SMTP no configurado: faltan SMTP_USER / SMTP_PASS"
    );
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: SMTP_USER_FINAL,
      pass: SMTP_PASS_FINAL,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });

  transporterVerifyPromise = transporter
    .verify()
    .then(() => {
      console.log("[MAIL] ✅ SMTP verificado correctamente");
      return true;
    })
    .catch((err) => {
      console.warn(
        "[MAIL] ⚠️ SMTP verify falló:",
        err?.message || err
      );
      return false;
    });

  return transporter;
}

async function ensureTransporter() {
  if (!transporter) initSmtp();

  if (!transporter) {
    throw new Error("SMTP_NOT_CONFIGURED");
  }

  if (transporterVerifyPromise) {
    await transporterVerifyPromise;
  }

  return transporter;
}

function stripHtml(html = "") {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function sendOnce({ toArr, subject, html, text }) {
  const tr = await ensureTransporter();

  const fromHeader = buildFromHeader();

  if (!fromHeader) {
    throw new Error("SMTP_USER_MISSING");
  }

  const info = await tr.sendMail({
    from: fromHeader,
    to: toArr.join(", "),
    subject: subject || "Notificación",
    text: text || stripHtml(html),
    html: html || undefined,
  });

  return info;
}

/**
 * sendEmail({ to, subject, html, text })
 * sendEmail(to, subject, html)
 */
export const sendEmail = async (...args) => {
  try {
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
      console.warn("[MAIL] destinatario vacío");
      return {
        ok: false,
        error: "empty_recipient",
      };
    }

    const subject = payload.subject || "Notificación";
    const html = payload.html || payload.body || "";
    const text = payload.text || stripHtml(html);

    if (!SMTP_USER_FINAL || !SMTP_PASS_FINAL) {
      console.error(
        "[MAIL] SMTP no configurado"
      );

      return {
        ok: false,
        error: "smtp_not_configured",
      };
    }

    let lastErr = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(
          `[MAIL] Enviando intento ${attempt} ->`,
          toArr.join(", ")
        );

        const info = await sendOnce({
          toArr,
          subject,
          html,
          text,
        });

        console.log("[MAIL] ✅ enviado:", {
          messageId: info?.messageId || null,
          accepted: info?.accepted || [],
          rejected: info?.rejected || [],
        });

        return {
          ok: true,
          provider: "smtp",
          messageId: info?.messageId || null,
          accepted: info?.accepted || [],
          rejected: info?.rejected || [],
          response: info?.response || null,
        };

      } catch (err) {
        lastErr = err;

        console.error(
          `[MAIL] fallo intento ${attempt}:`,
          err?.message || err
        );

        await sleep(400 * attempt);
      }
    }

    return {
      ok: false,
      provider: "smtp",
      error: lastErr?.message || String(lastErr),
    };

  } catch (err) {
    console.error(
      "[MAIL] error inesperado:",
      err?.message || err
    );

    return {
      ok: false,
      provider: "smtp",
      error: err?.message || String(err),
    };
  }
};

/* =========================================================
   NUEVO
   DOCUMENTOS + RETIROS + ESTADOS
========================================================= */

export const sendDocumentUploadedEmail = async ({
  to,
  name,
  documentType,
}) => {
  return sendEmail({
    to,
    subject: "Documento recibido",
    html: `
      <div style="font-family:Arial;padding:20px">
        <h2>Documento recibido</h2>

        <p>Hola ${name || "Cliente"},</p>

        <p>
          Hemos recibido correctamente tu documento:
          <b>${documentType || "Documento"}</b>
        </p>

        <p>
          Nuestro equipo administrativo lo revisará pronto.
        </p>

        <hr />

        <p>
          Leones Broker
        </p>
      </div>
    `,
  });
};

export const sendDocumentApprovedEmail = async ({
  to,
  name,
}) => {
  return sendEmail({
    to,
    subject: "Documento aprobado",
    html: `
      <div style="font-family:Arial;padding:20px">
        <h2>Documento aprobado</h2>

        <p>Hola ${name || "Cliente"},</p>

        <p>
          Tu documento fue aprobado correctamente.
        </p>

        <p>
          Tu cuenta ya se encuentra verificada.
        </p>

        <hr />

        <p>
          Leones Broker
        </p>
      </div>
    `,
  });
};

export const sendDocumentRejectedEmail = async ({
  to,
  name,
}) => {
  return sendEmail({
    to,
    subject: "Documento rechazado",
    html: `
      <div style="font-family:Arial;padding:20px">
        <h2>Documento rechazado</h2>

        <p>Hola ${name || "Cliente"},</p>

        <p>
          Tu documento fue rechazado.
        </p>

        <p>
          Por favor vuelve a subir un documento válido.
        </p>

        <hr />

        <p>
          Leones Broker
        </p>
      </div>
    `,
  });
};

export const sendWithdrawPendingEmail = async ({
  to,
  name,
  amount,
}) => {
  return sendEmail({
    to,
    subject: "Solicitud de retiro recibida",
    html: `
      <div style="font-family:Arial;padding:20px">
        <h2>Retiro recibido</h2>

        <p>Hola ${name || "Cliente"},</p>

        <p>
          Hemos recibido tu solicitud de retiro.
        </p>

        <p>
          Monto solicitado:
          <b>$${amount}</b>
        </p>

        <p>
          Estado actual:
          <b>PENDIENTE</b>
        </p>

        <hr />

        <p>
          Leones Broker
        </p>
      </div>
    `,
  });
};

export const sendWithdrawApprovedEmail = async ({
  to,
  name,
  amount,
}) => {
  return sendEmail({
    to,
    subject: "Retiro aprobado",
    html: `
      <div style="font-family:Arial;padding:20px">
        <h2>Retiro aprobado</h2>

        <p>Hola ${name || "Cliente"},</p>

        <p>
          Tu retiro fue aprobado correctamente.
        </p>

        <p>
          Monto:
          <b>$${amount}</b>
        </p>

        <p>
          Estado:
          <b>APROBADO</b>
        </p>

        <hr />

        <p>
          Leones Broker
        </p>
      </div>
    `,
  });
};

export const sendWithdrawRejectedEmail = async ({
  to,
  name,
  amount,
}) => {
  return sendEmail({
    to,
    subject: "Retiro rechazado",
    html: `
      <div style="font-family:Arial;padding:20px">
        <h2>Retiro rechazado</h2>

        <p>Hola ${name || "Cliente"},</p>

        <p>
          Tu retiro fue rechazado.
        </p>

        <p>
          Monto:
          <b>$${amount}</b>
        </p>

        <p>
          Estado:
          <b>RECHAZADO</b>
        </p>

        <hr />

        <p>
          Leones Broker
        </p>
      </div>
    `,
  });
};

export default sendEmail;
