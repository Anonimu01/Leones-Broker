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

function normalizeSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^OANDA:/, "");
}

function normalizeSide(value) {
  const side = String(value || "BUY").toUpperCase();
  return side === "SELL" ? "SELL" : "BUY";
}

// =======================
// 🔥 PNL REAL
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
    wallet = new Wallet({
      user: userId,
      balanceOwn: 1000,
      balance: 1000,
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
// 🔥 RECALCULO CORRECTO
// =======================
async function recalculateWallet(userId, session = null) {
  const wallet = await Wallet.findOne({ user: userId }).session(session);
  if (!wallet) return;

  const openPositions = await Position.find({
    user: userId,
    status: "OPEN",
  }).session(session);

  let marginUsed = 0;
  let pnlFloating = 0;

  for (const pos of openPositions) {
    marginUsed += Number(pos.marginReserved || 0);
    pnlFloating += Number(pos.pnl || 0);
  }

  const balanceOwn = Number(wallet.balanceOwn || 0);
  const credit = Number(wallet.credit || 0);

  wallet.marginUsed = marginUsed;

  // 🔥 EQUITY REAL
  wallet.equity = balanceOwn + pnlFloating + credit;

  // 🔥 FREE MARGIN REAL
  wallet.freeMargin = wallet.equity - marginUsed;

  wallet.updatedAt = new Date();

  await wallet.save({ session });

  await User.updateOne(
    { _id: userId },
    { balance: wallet.balanceOwn },
    session ? { session } : {}
  );
}

// =======================
// 📈 UPDATE LIVE PRICE
// =======================
export const updateLivePrice = async ({ symbol, price }) => {
  const livePrice = normalizePrice(price);
  if (!livePrice) return;

  const positions = await Position.find({ status: "OPEN" });

  const users = new Set();

  for (const pos of positions) {
    if (normalizeSymbol(pos.symbol) !== normalizeSymbol(symbol)) continue;

    const pnl = computePnl({
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice: livePrice,
      qty: pos.qty,
    });

    pos.currentPrice = livePrice;
    pos.pnl = pnl;
    await pos.save();

    users.add(String(pos.user));
  }

  for (const u of users) {
    await recalculateWallet(u);
  }
};

// =======================
// 🚀 OPEN TRADE
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

    if (!symbol || !qty || !price) {
      throw new Error("datos invalidos");
    }

    const wallet = await getOrCreateWallet(userId, session);

    const margin = qty * price;

    if (wallet.balanceOwn < margin) {
      throw new Error("fondos insuficientes");
    }

    // 🔥 RESTAR MARGEN
    wallet.balanceOwn -= margin;
    await wallet.save({ session });

    const position = await Position.create(
      [
        {
          user: userId,
          symbol,
          side,
          qty,
          entryPrice: price,
          currentPrice: price,
          marginReserved: margin,
          status: "OPEN",
          pnl: 0,
        },
      ],
      { session }
    );

    await recalculateWallet(userId, session);

    await session.commitTransaction();

    return { ok: true, data: position[0] };
  } catch (err) {
    await session.abortTransaction();
    return { ok: false, error: err.message };
  } finally {
    session.endSession();
  }
};

// =======================
// 🔴 CLOSE TRADE (🔥 CLAVE)
// =======================
export const closeTrade = async ({ user, positionId, closePrice }) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = user._id;

    const position = await Position.findOne({
      _id: positionId,
      user: userId,
      status: "OPEN",
    }).session(session);

    if (!position) throw new Error("posicion no encontrada");

    const wallet = await getOrCreateWallet(userId, session);

    const exit = normalizePrice(closePrice);

    const pnl = computePnl({
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: exit,
      qty: position.qty,
    });

    const margin = Number(position.marginReserved || 0);

    // =========================
    // 🔥 AQUI ESTA LA MAGIA
    // =========================
    const newBalance =
      Number(wallet.balanceOwn || 0) + margin + pnl;

    wallet.balanceOwn = newBalance;
    wallet.balance = newBalance;

    await wallet.save({ session });

    // 🔴 CERRAR POSICION
    position.status = "CLOSED";
    position.closePrice = exit;
    position.pnl = pnl;
    position.closedAt = new Date();

    await position.save({ session });

    // 🔥 RECIEN AQUI RECALCULAMOS
    await recalculateWallet(userId, session);

    await session.commitTransaction();

    return {
      ok: true,
      data: {
        pnl,
        balance: newBalance,
      },
    };
  } catch (err) {
    await session.abortTransaction();
    return { ok: false, error: err.message };
  } finally {
    session.endSession();
  }
};

export default {
  openTrade,
  closeTrade,
  updateLivePrice,
};
