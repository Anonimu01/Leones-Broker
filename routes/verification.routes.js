// routes/verification.routes.js

import express from "express";
import crypto from "crypto";
import User from "../models/user.model.js";

const router = express.Router();

/* helper base url */
const getBaseUrl = (req) => {
  if (process.env.CLIENT_URL) {
    return process.env.CLIENT_URL.replace(/\/+$/, "");
  }

  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/+$/, "");
  }

  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");

  return `${protocol}://${host}`.replace(/\/+$/, "");
};

function safeTimingEqual(a, b) {
  try {
    const aBuf = Buffer.from(String(a || ""));
    const bBuf = Buffer.from(String(b || ""));
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch (e) {
    return false;
  }
}

async function verifyUserByToken({ token, email }) {
  const normalizedToken = String(token || "").trim();
  const normalizedEmail = email ? String(email).trim().toLowerCase() : null;

  if (!normalizedToken) {
    return { ok: false, status: 400, html: "<h2>Token inválido</h2>" };
  }

  const query = {
    $or: [
      { verificationToken: { $ne: null } },
      { verifyToken: { $ne: null } },
      { verify_token: { $ne: null } },
    ],
  };

  if (normalizedEmail) {
    query.email = normalizedEmail;
  }

  const users = await User.find(query).exec();

  let user = null;

  for (const u of users) {
    const candidates = [
      u.verificationToken,
      u.verifyToken,
      u.verify_token,
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (safeTimingEqual(candidate, normalizedToken)) {
        user = u;
        break;
      }
    }

    if (user) break;
  }

  if (!user) {
    return {
      ok: false,
      status: 400,
      html: "<h2>❌ Token inválido o expirado</h2>",
    };
  }

  const expires = user.verifyExpires || user.verify_expires || user.verificationExpires || user.verification_expires || null;
  if (expires && new Date(expires) < new Date()) {
    return {
      ok: false,
      status: 400,
      html: "<h2>❌ Token expirado</h2>",
    };
  }

  user.verified = true;
  user.verificationToken = null;
  user.verifyToken = null;
  user.verify_token = null;
  user.verifyExpires = null;
  user.verify_expires = null;
  user.verificationExpires = null;
  user.verification_expires = null;

  await user.save();

  return { ok: true, user };
}

/*
============================
 VERIFY EMAIL - NUEVO FORMATO
 /api/verification/verify?token=...&email=...
============================
*/
router.get("/verify", async (req, res) => {
  try {
    const { token, email } = req.query || {};
    const result = await verifyUserByToken({ token, email });

    if (!result.ok) {
      return res.status(result.status || 400).send(result.html || "<h2>Error verificando cuenta</h2>");
    }

    const redirect = getBaseUrl(req);

    return res.send(`
      <h2>✅ Correo verificado correctamente</h2>
      <p>Redirigiendo...</p>
      <script>
        setTimeout(() => {
          window.location.href = "${redirect}";
        }, 2000);
      </script>
    `);
  } catch (error) {
    console.error("Verification error:", error);
    return res.status(500).send("<h2>Error del servidor</h2>");
  }
});

/*
============================
 VERIFY EMAIL - FORMATO ANTIGUO
 /api/verification/email/:token
============================
*/
router.get("/email/:token", async (req, res) => {
  try {
    const token = (req.params.token || "").trim();
    const email = req.query.email || null;

    const result = await verifyUserByToken({ token, email });

    if (!result.ok) {
      return res.status(result.status || 400).send(result.html || "<h2>Error verificando cuenta</h2>");
    }

    const redirect = getBaseUrl(req);

    return res.send(`
      <h2>✅ Correo verificado correctamente</h2>
      <p>Redirigiendo...</p>
      <script>
        setTimeout(() => {
          window.location.href = "${redirect}";
        }, 2000);
      </script>
    `);
  } catch (error) {
    console.error("Verification error:", error);
    return res.status(500).send("<h2>Error del servidor</h2>");
  }
});

/*
============================
 RESEND SAFE REDIRECT TEST
============================
*/
router.get("/ping", (req, res) => {
  res.json({
    ok: true,
    route: "verification",
    status: "working",
  });
});

export default router;
