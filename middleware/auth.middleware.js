import jwt from "jsonwebtoken";

export const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader)
    return res.status(401).json({ msg: "Token requerido" });

  const token = authHeader.split(" ")[1];

  if (!token)
    return res.status(401).json({ msg: "Token inválido" });

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "dev_secret"
    );

    req.user = decoded;
    next();
  } catch (err) {
    console.error("JWT ERROR:", err.message);
    res.status(401).json({ msg: "Token inválido" });
  }
};
