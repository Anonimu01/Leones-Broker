// middlewares/auth.middleware.js
import jwt from "jsonwebtoken";

export const authMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader)
      return res.status(401).json({ msg: "Token requerido" });

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer")
      return res.status(401).json({ msg: "Formato de token inválido" });

    const token = parts[1];
    if (!token || token.length < 10)
      return res.status(401).json({ msg: "Token inválido" });

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "dev_secret"
    );

    req.user = decoded;
    next();
  } catch (err) {
    if (err && err.name === "TokenExpiredError") {
      return res.status(401).json({ msg: "Token expirado" });
    }
    console.error("JWT ERROR:", err && err.message);
    res.status(401).json({ msg: "Token inválido" });
  }
};

// Export por defecto también para compatibilidad con imports que esperan default
export default authMiddleware;
