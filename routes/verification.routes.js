import express from "express";
import User from "../models/user.model.js";

const router = express.Router();


// ============================
// VERIFICAR EMAIL
// ============================
router.get("/email/:token", async (req, res) => {
  try {

    const user = await User.findOne({
      verificationToken: req.params.token
    });

    if (!user)
      return res.send("<h2>❌ Token inválido o expirado</h2>");

    user.verified = true;
    user.verificationToken = null;
    await user.save();

    res.send(`
      <h2>✅ Correo verificado correctamente</h2>
      <p>Puedes cerrar esta página e iniciar sesión.</p>
      <script>
        setTimeout(()=>{
          window.location.href = "${process.env.BASE_URL}";
        }, 3000)
      </script>
    `);

  } catch (error) {
    console.error("Error verificación:", error);
    res.status(500).send("Error del servidor");
  }
});

export default router;
