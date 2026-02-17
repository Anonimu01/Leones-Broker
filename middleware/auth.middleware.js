import jwt from "jsonwebtoken";
import User from "../models/user.model.js";

export const authMiddleware = async (req, res, next) => {
  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Bearer "))
      return res.status(401).json({ msg: "Acceso no autorizado" });

    const token = header.split(" ")[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id).select("-password -verificationToken");

    if (!user)
      return res.status(401).json({ msg: "Usuario no válido" });

    req.user = user;

    next();

  } catch (error) {
    console.error("Auth error:", error.message);
    res.status(401).json({ msg: "Token inválido o expirado" });
  }
};
