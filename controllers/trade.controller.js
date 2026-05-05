import Position from "../models/position.model.js";
import Wallet from "../models/wallet.model.js";
import User from "../models/user.model.js";
import mongoose from "mongoose";

// =======================
// HELPERS
// =======================
function toNumber(v, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}

function normalizeSide(side) {
  return String(side || "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY";
}

// =======================
// WALLET
// =======================
async function getWallet(userId, session) {
  let wallet = await Wallet.findOne({ user: userId }).session(session);

  if (!wallet) {
    wallet = new Wallet({
      user: userId,
      balance: 1000,
      balanceOwn: 1000,
      credit: 0,
      marginUsed: 0,
      equity: 1000,
      freeMargin: 1000,
    });

    await wallet.save({ session });
  }

  return wallet;
}

// =======================
// 🔵 OPEN TRADE
// =======================
export const openTrade = async ({ user, order }) => {
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const userId = user?._id || user?.id;
    if (!userId) throw new Error("Usuario inválido");

    const position = new Position({
      user: userId,
      symbol: order.symbol,
      side: normalizeSide(order.side),
      qty: toNumber(order.qty || order.quantity),
      entryPrice: toNumber(order.price),
      status: "OPEN",
      marginReserved: toNumber(order.price) * toNumber(order.qty || order.quantity),
      createdAt: new Date(),
    });

    await position.save({ session });

    const wallet = await getWallet(userId, session);

    wallet.marginUsed += position.marginReserved;
    wallet.freeMargin = wallet.balance - wallet.marginUsed;

    await wallet.save({ session });

    await session.commitTransaction();
    session.endSession();

    return {
      ok: true,
      data: position,
    };
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    session.endSession();

    return {
      ok: false,
      error: err.message,
    };
  }
};

// =======================
// 🔴 CLOSE TRADE (TU LÓGICA)
// =======================
export const closeTrade = async ({ user, positionId, price }) => {
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const userId = user?._id || user?.id;

    const position = await Position.findOne({
      _id: positionId,
      user: userId,
      status: "OPEN",
    }).session(session);

    if (!position) throw new Error("Posición no encontrada");

    const wallet = await getWallet(userId, session);

    const exit = toNumber(price || position.entryPrice);

    const pnl =
      position.side === "SELL"
        ? (position.entryPrice - exit) * position.qty
        : (exit - position.entryPrice) * position.qty;

    wallet.balance += pnl;
    wallet.balanceOwn += pnl;
    wallet.marginUsed -= position.marginReserved;
    wallet.freeMargin = wallet.balance - wallet.marginUsed;

    await wallet.save({ session });

    position.status = "CLOSED";
    position.closePrice = exit;
    position.pnl = pnl;
    position.closedAt = new Date();

    await position.save({ session });

    await session.commitTransaction();
    session.endSession();

    return { ok: true, pnl };
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    session.endSession();

    return { ok: false, error: err.message };
  }
};

export default { openTrade, closeTrade };
