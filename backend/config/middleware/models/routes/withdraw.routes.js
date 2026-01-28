import express from "express";
import Withdraw from "../models/Withdraw.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();

router.post("/", auth(), async (req, res) => {
  const { amount } = req.body;
  await Withdraw.create({
    userId: req.user.id,
    amount
  });
  res.json({ ok: true });
});

export default router;
