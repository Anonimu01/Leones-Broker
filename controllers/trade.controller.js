import Position from "../models/position.model.js";
import Wallet from "../models/wallet.model.js";
import User from "../models/user.model.js";
import mongoose from "mongoose";

// =======================
// HELPERS
// =======================
function normalizePrice(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeSymbol(v) {
  return String(v || "").trim().toUpperCase().replace(/^OANDA:/, "");
}

function normalizeSide(v) {
  const s = String(v || "BUY").toUpperCase();
  return s === "SELL" ? "SELL" : "BUY";
}

// =======================
// 🔥 PNL REAL
// =======================
function computePnl({ side, entryPrice, exitPrice, qty }) {
  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  const q = Number(qty);

  if (!entry || !exit || !q) return 0;

  return side === "SELL"
    ? (entry - exit) * q
    : (exit - entry) * q;
}

// =======================
// WALLET
// =======================
async function getOrCreateWallet(userId, session) {
  let wallet = await Wallet.findOne({ user: userId }).session(session);

  if (!wallet) {
    const user = await User.findById(userId).session(session);

    const balance = Number(user?.balance || 1000);

    const created = await Wallet.create([{
      user: userId,
      balanceOwn: balance,
      balance: balance,
      equity: balance,
      freeMargin: balance,
      marginUsed: 0,
    }], { session });

    wallet = created[0];
  }

  return wallet;
}

// =======================
// 🔥 RECALCULO FORZADO
// =======================
async function recalcWallet(userId, session) {
  const wallet = await Wallet.findOne({ user: userId }).session(session);
  if (!wallet) return;

  const open = await Position.find({
    user: userId,
    status: "OPEN",
  }).session(session);

  let pnl = 0;
  let margin = 0;

  for (const p of open) {
    pnl += Number(p.pnl || 0);
    margin += Number(p.marginReserved || 0);
  }

  const balance = Number(wallet.balanceOwn || 0);

  wallet.balance = balance;
  wallet.marginUsed = margin;

  // 🔥 SIN INVENTOS
  wallet.equity = balance + pnl;
  wallet.freeMargin = balance;

  await wallet.save({ session });

  await User.updateOne(
    { _id: userId },
    { $set: { balance } },
    { session }
  );
}

// =======================
// 📈 UPDATE PRICE
// =======================
export const updateLivePrice = async ({ symbol, price }) => {
  const live = normalizePrice(price);
  if (!live) return;

  const clean = normalizeSymbol(symbol);

  const positions = await Position.find({
    symbol: clean,
    status: "OPEN",
  });

  const users = new Set();

  for (const p of positions) {
    const pnl = computePnl({
      side: p.side,
      entryPrice: p.entryPrice,
      exitPrice: live,
      qty: p.qty,
    });

    p.currentPrice = live;
    p.pnl = pnl;

    await p.save();
    users.add(String(p.user));
  }

  for (const u of users) {
    await recalcWallet(u);
  }
};

// =======================
// 🚀 OPEN
// =======================
export const openTrade = async ({ user, order }) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = user._id;

    const symbol = normalizeSymbol(order.symbol);
    const side = normalizeSide(order.side);
    const qty = Number(order.quantity);
    const price = normalizePrice(order.price);

    const wallet = await getOrCreateWallet(userId, session);

    const margin = qty * price;

    if (wallet.balanceOwn < margin) {
      throw new Error("Sin fondos");
    }

    // 🔥 RESTA SIEMPRE
    wallet.balanceOwn -= margin;
    wallet.balance = wallet.balanceOwn;

    await wallet.save({ session });

    await Position.create([{
      user: userId,
      symbol,
      side,
      qty,
      entryPrice: price,
      currentPrice: price,
      marginReserved: margin,
      status: "OPEN",
      pnl: 0,
    }], { session });

    await recalcWallet(userId, session);

    await session.commitTransaction();

    return { ok: true };

  } catch (e) {
    await session.abortTransaction();
    return { ok: false, error: e.message };
  } finally {
    session.endSession();
  }
};

// =======================
// 🔴 CLOSE (FORZADO)
// =======================
export const closeTrade = async ({ user, positionId, closePrice }) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = user._id;
    const price = normalizePrice(closePrice);

    const pos = await Position.findOne({
      _id: positionId,
      user: userId,
      status: "OPEN",
    }).session(session);

    if (!pos) throw new Error("No existe");

    const wallet = await getOrCreateWallet(userId, session);

    const pnl = computePnl({
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice: price,
      qty: pos.qty,
    });

    const margin = Number(pos.marginReserved || 0);

    // 🔥🔥🔥 FORZADO REAL
    wallet.balanceOwn =
      Number(wallet.balanceOwn) +
      margin +
      pnl;

    wallet.balance = wallet.balanceOwn;

    await wallet.save({ session });

    // 🔥 RESET PNL A 0 (IMPORTANTE)
    pos.status = "CLOSED";
    pos.closePrice = price;
    pos.pnl = 0;        // 👈 ESTO ERA LO QUE TE FALTABA
    pos.profit = pnl;

    await pos.save({ session });

    await recalcWallet(userId, session);

    await session.commitTransaction();

    return {
      ok: true,
      data: {
        pnl,
        balance: wallet.balanceOwn,
      },
    };

  } catch (e) {
    await session.abortTransaction();
    return { ok: false, error: e.message };
  } finally {
    session.endSession();
  }
};

export default {
  openTrade,
  closeTrade,
  updateLivePrice,
};
