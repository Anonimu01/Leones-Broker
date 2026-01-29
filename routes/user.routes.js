import express from "express";
const router = express.Router();

router.get("/profile", (req, res) => {
  res.json({ msg: "perfil cliente" });
});

export default router;

