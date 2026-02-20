import jwt from "jsonwebtoken";

export default function (req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader)
    return res.status(401).json({ msg: "Token requerido" });

  const token = authHeader.split(" ")[1];

  if (!token)
    return res.status(401).json({ msg: "Token inválido" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ msg: "Token inválido" });
  }
}
