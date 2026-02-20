import jwt from "jsonwebtoken";

export default function authMiddleware(req, res, next) {
  try {

    const header = req.headers.authorization;

    if (!header)
      return res.status(401).json({
        msg: "No autorizado — token requerido"
      });

    /* formato esperado: Bearer TOKEN */
    const parts = header.split(" ");

    if (parts.length !== 2 || parts[0] !== "Bearer")
      return res.status(401).json({
        msg: "Formato de token inválido"
      });

    const token = parts[1];

    if (!token || token.length < 10)
      return res.status(401).json({
        msg: "Token inválido"
      });

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "dev_secret"
    );

    req.user = decoded;

    next();

  } catch (err) {

    if (err.name === "TokenExpiredError")
      return res.status(401).json({
        msg: "Token expirado"
      });

    if (err.name === "JsonWebTokenError")
      return res.status(401).json({
        msg: "Token inválido"
      });

    console.error("Auth middleware error:", err);

    res.status(500).json({
      msg: "Error autenticando usuario"
    });
  }
}
