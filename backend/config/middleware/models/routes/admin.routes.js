import express from "express";
import User from "../models/User.js";
import Withdraw from "../models/Withdraw.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();

router.get("/users", auth("admin"), async (req, res) => {
  res.json(await User.find());
});

router.post("/update-balance", auth("admin"), async (req, res) => {
  const { userId, balance } = req.body;
  await User.findByIdAndUpdate(userId, { balance });
  res.json({ ok: true });
});

router.post("/withdraw/approve", auth("admin"), async (req, res) => {
  await Withdraw.findByIdAndUpdate(req.body.id, {
    status: "approved"
  });
  res.json({ ok: true });
});

export default router;
