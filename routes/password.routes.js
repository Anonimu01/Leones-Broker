import express from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";

import User from "../models/user.model.js";

const router = express.Router();

/* =========================================
   FORGOT PASSWORD
========================================= */

router.post("/forgot-password", async (req, res) => {

  try {

    const { email } = req.body;

    const user = await User.findOne({ email });

    if (!user) {

      return res.status(404).json({
        message: "Usuario no encontrado",
      });

    }

    /* TOKEN */

    const resetToken =
      crypto.randomBytes(32).toString("hex");

    /* EXPIRACIÓN */

    user.resetPasswordToken = resetToken;

    user.resetPasswordExpire =
      Date.now() + 1000 * 60 * 15;

    await user.save();

    /* LINK */

    const resetLink =
      `${process.env.CLIENT_URL}/reset-password.html?token=${resetToken}`;

    /* EMAIL */

    await req.app.locals.sendEmail({

      to: user.email,

      subject: "Restablecer contraseña",

      html: `
        <div style="
          background:#111;
          color:#fff;
          padding:40px;
          font-family:Arial;
        ">

          <h2 style="color:#cfa240">
            Restablece tu contraseña
          </h2>

          <p>
            Haz clic en el botón:
          </p>

          <a href="${resetLink}"
             style="
               display:inline-block;
               padding:14px 24px;
               background:#cfa240;
               color:#111;
               text-decoration:none;
               border-radius:10px;
               font-weight:bold;
             ">

             Restablecer contraseña

          </a>

          <p style="margin-top:20px">
            Este enlace expira en 15 minutos.
          </p>

        </div>
      `,
    });

    res.json({
      success: true,
      message: "Correo enviado",
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      success: false,
      message: "Error del servidor",
    });

  }

});

/* =========================================
   RESET PASSWORD
========================================= */

router.post("/reset-password", async (req, res) => {

  try {

    const { token, password } = req.body;

    const user = await User.findOne({

      resetPasswordToken: token,

      resetPasswordExpire: {
        $gt: Date.now(),
      },

    });

    if (!user) {

      return res.status(400).json({
        message: "Token inválido o expirado",
      });

    }

    /* HASH PASSWORD */

    const salt =
      await bcrypt.genSalt(10);

    user.password =
      await bcrypt.hash(password, salt);

    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;

    await user.save();

    res.json({
      success: true,
      message: "Contraseña actualizada",
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      success: false,
      message: "Error del servidor",
    });

  }

});

export default router;
