// routes/adminWithdrawRoutes.js
import express from "express";
import Withdraw from "../models/withdraw.model.js";
import User from "../models/user.model.js";
import Wallet from "../models/wallet.model.js";
import { recordTransaction } from "../utils/transactions.js";
import { requireAdmin } from "../middleware/authAdmin.js";
import sendEmail from "../utils/sendEmail.js";

const router = express.Router();

/* ======================================================
   GET ALL WITHDRAW REQUESTS
===================================================== */
router.get("/", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const withdraws = await Withdraw.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();

    return res.json({ ok: true, count: withdraws.length, withdraws, data: withdraws, items: withdraws });
  } catch (err) {
    console.error("/adminWithdrawRoutes GET error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err.message });
  }
});

/* ======================================================
   APPROVE WITHDRAW
===================================================== */
router.post("/approve", requireAdmin, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ ok: false, error: "id_required" });

    const withdraw = await Withdraw.findById(id);
    if (!withdraw) return res.status(404).json({ ok: false, error: "withdraw_not_found" });
    if (withdraw.status === "approved") return res.status(400).json({ ok: false, error: "already_approved" });

    const user = await User.findById(withdraw.userId);
    if (!user) return res.status(404).json({ ok: false, error: "user_not_found" });

    const wallet = await Wallet.findOne({ user: user._id });
    if (!wallet) return res.status(404).json({ ok: false, error: "wallet_not_found" });

    const balanceBefore = Number(wallet.balanceOwn ?? wallet.balance ?? 0);
    if (balanceBefore < withdraw.amount) {
      return res.status(400).json({ ok: false, error: "insufficient_balance" });
    }

    // Actualizar wallet
    wallet.balanceOwn = balanceBefore - withdraw.amount;
    wallet.balance = wallet.balanceOwn;
    wallet.updatedAt = new Date();
    await wallet.save();

    // Actualizar retiro
    withdraw.status = "approved";
    withdraw.processedAt = new Date();
    await withdraw.save();

    // Registrar transacción
    const tx = await recordTransaction({
      user,
      type: "withdrawal",
      amount: -Math.abs(withdraw.amount),
      status: "completed",
      note: "Retiro aprobado por admin",
      balanceBefore,
      balanceAfter: wallet.balanceOwn,
      meta: { withdrawId: withdraw._id },
      source: "adminWithdrawRoutes/approve",
    });

    // Notificar usuario
    if (user.email) {
      await sendEmail(
        user.email,
        "Retiro aprobado",
        `<h2>Retiro aprobado</h2><p>Su solicitud de retiro de ${withdraw.amount} ${wallet.currency || "USD"} ha sido aprobada.</p>`
      );
    }

    return res.json({ ok: true, msg: "Retiro aprobado", withdraw, transaction: tx });
  } catch (err) {
    console.error("/adminWithdrawRoutes /approve error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err.message });
  }
});

/* ======================================================
   REJECT WITHDRAW
===================================================== */
router.post("/reject", requireAdmin, async (req, res) => {
  try {
    const { id, reason } = req.body;
    if (!id) return res.status(400).json({ ok: false, error: "id_required" });

    const withdraw = await Withdraw.findById(id);
    if (!withdraw) return res.status(404).json({ ok: false, error: "withdraw_not_found" });
    if (withdraw.status === "rejected") return res.status(400).json({ ok: false, error: "already_rejected" });

    withdraw.status = "rejected";
    withdraw.rejectedAt = new Date();
    withdraw.rejectReason = reason || "No especificado";
    await withdraw.save();

    const user = await User.findById(withdraw.userId);

    if (user?.email) {
      await sendEmail(
        user.email,
        "Retiro rechazado",
        `<h2>Retiro rechazado</h2><p>Su solicitud de retiro de ${withdraw.amount} ${withdraw.currency || "USD"} fue rechazada.</p><p>Motivo: ${withdraw.rejectReason}</p>`
      );
    }

    return res.json({ ok: true, msg: "Retiro rechazado", withdraw });
  } catch (err) {
    console.error("/adminWithdrawRoutes /reject error:", err);
    return res.status(500).json({ ok: false, error: "server_error", message: err.message });
  }
});

export default router;
