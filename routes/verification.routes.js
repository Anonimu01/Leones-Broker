import express from "express";
import crypto from "crypto";
import User from "../models/user.model.js";

const router = express.Router();

/* helper base url */
const getBaseUrl = (req) => {
  if (process.env.BASE_URL)
    return process.env.BASE_URL.replace(/\/+$/, "");

  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");

  return `${protocol}://${host}`;
};


// ============================
// VERIFY EMAIL
// ============================
router.get("/email/:token", async (req, res) => {
  try {

    const token = (req.params.token || "").trim();

    if (!token)
      return res.status(400).send("<h2>Token inválido</h2>");

    /* comparación segura */
    const users = await User.find({
      verificationToken: { $ne: null }
    });

    let user = null;

    for (const u of users) {
      if (
        crypto.timingSafeEqual(
          Buffer.from(u.verificationToken),
          Buffer.from(token)
        )
      ) {
        user = u;
        break;
      }
    }

    if (!user)
      return res.send("<h2>❌ Token inválido o expirado</h2>");

    user.verified = true;
    user.verificationToken = null;
    await user.save();

    const redirect = getBaseUrl(req);

    res.send(`
      <h2>✅ Correo verificado correctamente</h2>
      <p>Redirigiendo...</p>

      <script>
        setTimeout(()=>{
          window.location.href = "${redirect}";
        },2000)
      </script>
    `);

  } catch (error) {
    console.error("Verification error:", error);
    res.status(500).send("<h2>Error del servidor</h2>");
  }
});

export default router;
