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
      return res.status(result.status || 400).send(`
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Error de Verificación</title>

<style>

body{
  margin:0;
  padding:0;
  background:#0b1020;
  height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  font-family:Arial,sans-serif;
}

.card{
  width:90%;
  max-width:600px;
  background:rgba(255,255,255,0.05);
  border:1px solid rgba(255,0,0,0.25);
  border-radius:25px;
  padding:50px;
  text-align:center;
  color:white;
  backdrop-filter:blur(15px);
}

h1{
  color:#ff4d4d;
  font-size:40px;
  margin-bottom:20px;
}

p{
  font-size:20px;
  line-height:1.7;
}

</style>
</head>

<body>

<div class="card">
  <h1>❌ Error</h1>
  <p>
    El enlace de verificación no es válido o ha expirado.
  </p>
</div>

</body>
</html>
`);
    }

    const redirect = getBaseUrl(req);

    return res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>Cuenta Verificada</title>

<style>

*{
  margin:0;
  padding:0;
  box-sizing:border-box;
}

body{
  background:#0b1020;
  height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  overflow:hidden;
  font-family:Arial, sans-serif;
}

.glow{
  position:absolute;
  width:500px;
  height:500px;
  border-radius:50%;
  background:rgba(212,175,55,0.15);
  filter:blur(120px);
}

.glow.one{
  top:-150px;
  left:-100px;
}

.glow.two{
  bottom:-150px;
  right:-100px;
}

.card{
  position:relative;
  z-index:2;
  width:90%;
  max-width:700px;
  padding:70px 50px;
  border-radius:30px;
  background:rgba(255,255,255,0.05);
  border:1px solid rgba(212,175,55,0.25);
  backdrop-filter:blur(20px);
  text-align:center;
  box-shadow:0 0 50px rgba(212,175,55,0.2);
  animation:fadeIn 1s ease;
}

.icon{
  width:130px;
  height:130px;
  margin:auto;
  border-radius:50%;
  background:linear-gradient(135deg,#d4af37,#f5d76e);
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:70px;
  color:#111;
  margin-bottom:35px;
  box-shadow:0 0 30px rgba(212,175,55,0.5);
}

h1{
  color:#f5d76e;
  font-size:45px;
  margin-bottom:25px;
}

p{
  color:white;
  font-size:22px;
  line-height:1.8;
  opacity:0.95;
}

.btn{
  display:inline-block;
  margin-top:40px;
  padding:18px 42px;
  border-radius:14px;
  text-decoration:none;
  background:linear-gradient(135deg,#d4af37,#f5d76e);
  color:#111;
  font-size:18px;
  font-weight:bold;
  transition:0.3s;
}

.btn:hover{
  transform:scale(1.05);
  box-shadow:0 0 25px rgba(212,175,55,0.5);
}

@keyframes fadeIn{
  from{
    opacity:0;
    transform:translateY(30px);
  }
  to{
    opacity:1;
    transform:translateY(0);
  }
}

</style>
</head>

<body>

<div class="glow one"></div>
<div class="glow two"></div>

<div class="card">

  <div class="icon">
    ✓
  </div>

  <h1>Bienvenido a Leones Broker</h1>

  <p>
    Tu correo electrónico ha sido confirmado correctamente.
    <br><br>
    Ya puedes iniciar sesión en tu cuenta.
  </p>

  <a class="btn" href="${redirect}">
    Iniciar Sesión
  </a>

</div>

<script>
setTimeout(() => {
  window.location.href = "${redirect}";
}, 6000);
</script>

</body>
</html>
`);
  } catch (error) {
    console.error("Verification error:", error);

    return res.status(500).send(`
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Error del servidor</title>

<style>

body{
  margin:0;
  padding:0;
  background:#0b1020;
  height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  font-family:Arial,sans-serif;
}

.card{
  width:90%;
  max-width:600px;
  background:rgba(255,255,255,0.05);
  border-radius:25px;
  padding:50px;
  text-align:center;
  color:white;
  border:1px solid rgba(255,255,255,0.1);
}

h1{
  color:#ff4d4d;
  font-size:40px;
  margin-bottom:20px;
}

p{
  font-size:20px;
  line-height:1.7;
}

</style>
</head>

<body>

<div class="card">
  <h1>⚠️ Error del servidor</h1>
  <p>
    Ocurrió un problema verificando tu cuenta.
    <br><br>
    Inténtalo nuevamente más tarde.
  </p>
</div>

</body>
</html>
`);
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
