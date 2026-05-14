import crypto from "crypto";
import User from "../models/user.model.js";
import sendEmail from "../utils/sendEmail.js";

export const forgotPassword = async (req, res) => {

  try {

    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        message: "Email requerido",
      });
    }

    const user = await User.findOne({
      email: email.trim().toLowerCase(),
    });

    if (!user) {
      return res.status(404).json({
        message: "Usuario no encontrado",
      });
    }

    /* TOKEN */

    const resetToken =
      crypto.randomBytes(32).toString("hex");

    user.resetPasswordToken = resetToken;

    user.resetPasswordExpires =
      Date.now() + 1000 * 60 * 30;

    await user.save();

    /* LINK */

    const resetLink =
      `${process.env.CLIENT_URL}/reset-password.html?token=${resetToken}`;

    /* EMAIL */

    await sendEmail({
      to: user.email,

      subject: "Recuperar contraseña",

      html: `
        <div style="font-family:Arial;padding:20px">
          
          <h2>Recuperar contraseña</h2>

          <p>
            Haz click en el siguiente botón
            para restablecer tu contraseña:
          </p>

          <a
            href="${resetLink}"
            style="
              display:inline-block;
              padding:12px 20px;
              background:#cfa240;
              color:#111;
              text-decoration:none;
              border-radius:8px;
              font-weight:bold;
            "
          >
            Restablecer contraseña
          </a>

          <p style="margin-top:20px">
            Este enlace expirará en 30 minutos.
          </p>

        </div>
      `,
    });

    res.json({
      success: true,
      message: "Correo enviado",
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      message: "Error del servidor",
    });

  }

};
