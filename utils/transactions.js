// utils/transactions.js
import mongoose from "mongoose";

const transactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    userId: { type: String, index: true },
    type: { type: String, index: true },
    amount: { type: Number, default: 0 },
    status: { type: String, default: "completed" },
    note: { type: String, default: "" },
    balanceBefore: { type: Number, default: 0 },
    balanceAfter: { type: Number, default: 0 },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    source: { type: String, default: "server.js" },
    createdAt: { type: Date, default: Date.now },
  },
  { minimize: false }
);

const Transaction = mongoose.models.Transaction || mongoose.model("Transaction", transactionSchema);

/**
 * Crea un registro de transacción
 */
export async function recordTransaction({
  user,
  type,
  amount = 0,
  status = "completed",
  note = "",
  balanceBefore = 0,
  balanceAfter = 0,
  meta = {},
  source = "server.js",
}) {
  try {
    const tx = await Transaction.create({
      user: user?._id || null,
      userId: String(user?._id || ""),
      type,
      amount: Number(amount) || 0,
      status,
      note,
      balanceBefore: Number(balanceBefore) || 0,
      balanceAfter: Number(balanceAfter) || 0,
      meta,
      source,
      createdAt: new Date(),
    });
    return tx.toObject ? tx.toObject() : tx;
  } catch (err) {
    console.warn("recordTransaction fallback:", err?.message || err);
    return {
      userId: String(user?._id || ""),
      type,
      amount: Number(amount) || 0,
      status,
      note,
      balanceBefore: Number(balanceBefore) || 0,
      balanceAfter: Number(balanceAfter) || 0,
      meta,
      source,
      createdAt: new Date().toISOString(),
    };
  }
}

/**
 * Carga las últimas transacciones de un usuario
 */
export async function loadTransactionsForUser(userId, limit = 50) {
  return await Transaction.find({ user: userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()
    .exec()
    .catch(() => []);
}

export default Transaction;
