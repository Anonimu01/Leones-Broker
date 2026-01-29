import express from "express";
import User from "../models/user.model.js";

const router = express.Router();

router.get("/email/:token", async (req, res) => {
  const user = await User.findOne({
    verificationToken: req.params.token
  });

  if (!user) return res.send("Token inválido");

  user.verified = true;
  user.verificationToken = null;
  await user.save();

  res.send(`
    <h2>✅ Correo verificado correctamente</h2>
    <p>Ya puedes iniciar sesión.</p>
  `);
});

export default router;
