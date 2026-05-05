import Position from "../models/position.model.js";
import Wallet from "../models/wallet.model.js";
import User from "../models/user.model.js";
import mongoose from "mongoose";

// =======================
// 🔧 HELPERS
// =======================
function normalizePrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeSide(value) {
  const side = String(value || "BUY").toUpperCase();
  return side === "SELL" ? "SELL" : "BUY";
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeEndSession(session) {
  try {
    if (session) session.endSession();
  } catch {}
}

// =======================
// 🔥 PNL CALC
// =======================
function computePnl({ side, entryPrice, exitPrice, qty }) {
  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  const quantity = Number(qty);

  if (!entry || !exit || !quantity) return 0;

  return side === "SELL"
    ? (entry - exit) * quantity
    : (exit - entry) * quantity;
}

// =======================
// 🔥 WALLET
// =======================
async function getOrCreateWallet(userId, session = null) {
  let wallet = await Wallet.findOne({ user: userId }).session(session);

  if (!wallet) {
    const userDoc = await User.findById(userId).session(session).catch(() => null);

    const initialBalance = toNumber(userDoc?.balance, 1000);
    const initialCredit = toNumber(userDoc?.credit, 0);

    wallet = new Wallet({
      user: userId,
      balanceOwn: initialBalance,
      balance: initialBalance,
      credit: initialCredit,
      marginUsed: 0,
      equity: initialBalance + initialCredit,
      freeMargin: initialBalance + initialCredit,
      marginLevel: 0,
    });

    await wallet.save({ session });
  }

  return wallet;
}

// ======================================================
// 🚨 OPEN TRADE (FIX PARA QUE NO CRASHEE)
// ======================================================
export const openTrade = async ({ user, order }) => {
  try {
    const userId = user?._id || user?.id;
    if (!userId) throw new Error("Usuario inválido");

    const symbol = order?.symbol;
    const side = normalizeSide(order?.side);
    const qty = toNumber(order?.qty || order?.quantity);
    const price = toNumber(order?.price);

    if (!symbol || !qty || !price) {
      throw new Error("Datos inválidos para abrir trade");
    }

    const wallet = await getOrCreateWallet(userId);

    const position = await Position.create({
      user: userId,
      symbol,
      side,
      qty,
      entryPrice: price,
      currentPrice: price,
      status: "OPEN",
      pnl: 0,
      profit: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return {
      ok: true,
      data: position,
      wallet,
    };
  } catch (err) {
    console.error("❌ OPEN TRADE ERROR:", err);
    return {
      ok: false,
      error: err.message || "Error abriendo operación",
    };
  }
};

// =======================
// 🔴 CLOSE TRADE (YA FUNCIONABA)
// =======================
export const closeTrade = async ({ user, positionId, price, closePrice }) => {
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const userId = user?._id || user?.id;
    if (!userId) throw new Error("Usuario inválido");

    if (!positionId || !mongoose.Types.ObjectId.isValid(positionId)) {
      throw new Error("positionId inválido");
    }

    const position = await Position.findOne({
      _id: positionId,
      user: userId,
      status: "OPEN",
    }).session(session);

    if (!position) {
      throw new Error("Posición no encontrada o ya cerrada");
    }

    const wallet = await getOrCreateWallet(userId, session);

    let exit =
      normalizePrice(closePrice) ||
      normalizePrice(price) ||
      normalizePrice(position.currentPrice) ||
      normalizePrice(position.entryPrice) ||
      1;

    const pnl = computePnl({
      side: normalizeSide(position.side),
      entryPrice: position.entryPrice,
      exitPrice: exit,
      qty: position.qty,
    });

    const margin = toNumber(position.marginReserved, 0);

    const balanceBefore = toNumber(wallet.balanceOwn, 0);
    const newBalance = balanceBefore + pnl;

    wallet.balanceOwn = newBalance;
    wallet.balance = newBalance;
    wallet.marginUsed = Math.max(0, wallet.marginUsed - margin);
    wallet.equity = wallet.balanceOwn + wallet.credit;
    wallet.freeMargin = wallet.equity - wallet.marginUsed;
    wallet.updatedAt = new Date();

    await wallet.save({ session });

    position.status = "CLOSED";
    position.closePrice = exit;
    position.currentPrice = exit;
    position.pnl = pnl;
    position.profit = pnl;
    position.closedAt = new Date();
    position.updatedAt = new Date();

    await position.save({ session });

    await session.commitTransaction();
    safeEndSession(session);

    return {
      ok: true,
      data: {
        pnl,
        balance: newBalance,
        closePrice: exit,
        positionId: String(position._id),
      },
    };
  } catch (err) {
    await session.abortTransaction().catch(() => null);
    safeEndSession(session);

    console.error("❌ CLOSE TRADE ERROR:", err);

    return {
      ok: false,
      error: err.message || "Error cerrando operación",
    };
  }
};

export default { openTrade, closeTrade };
