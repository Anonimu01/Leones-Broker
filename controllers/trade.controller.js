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
  const side = String(value || "BUY").trim().toUpperCase();
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
    const user = await User.findById(userId).session(session);

    const balance = Number(user?.balance || 1000);

    wallet = await Wallet.create([{
      user: userId,
      balanceOwn: balance,
      balance: balance,
      marginUsed: 0,
      equity: balance,
      freeMargin: balance,
      leverageFactor: user?.leverage || 1,
    }], { session });

    wallet = wallet[0];
  }

  return wallet;
}

// =======================
// 🔥 RECALCULAR WALLET (CORRECTO)
// =======================
async function recalculateWalletMetrics(userId, session = null) {
  const wallet = await Wallet.findOne({ user: userId }).session(session);
  if (!wallet) return;

  const positions = await Position.find({
    user: userId,
    status: "OPEN",
  }).session(session);

  const marginUsed = positions.reduce((sum, p) => sum + (p.marginReserved || 0), 0);
  const openPnl = positions.reduce((sum, p) => sum + (p.pnl || 0), 0);

  const balance = Number(wallet.balanceOwn || 0);

  wallet.balance = balance;
  wallet.marginUsed = marginUsed;

  // 🔥 AQUÍ ESTÁ LA CLAVE
  wallet.equity = balance + openPnl;
  wallet.freeMargin = balance;

  wallet.marginLevel = marginUsed > 0
    ? (wallet.equity / marginUsed) * 100
    : 0;

  await wallet.save({ session });

  await User.updateOne(
    { _id: userId },
    { $set: { balance } },
    { session }
  );
}

// =======================
// 📈 UPDATE LIVE PRICE
// =======================
export const updateLivePrice = async ({ symbol, price }) => {
  const livePrice = normalizePrice(price);
  if (!livePrice) return;

  const cleanSymbol = normalizeSymbol(symbol);

  const positions = await Position.find({
    symbol: cleanSymbol,
    status: "OPEN",
  });

  const users = new Set();

  for (const pos of positions) {
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

  for (const userId of users) {
    await recalculateWalletMetrics(userId);
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

    let { symbol, side, quantity, price } = order;

    symbol = normalizeSymbol(symbol);
    side = normalizeSide(side);
    quantity = Number(quantity);
    price = normalizePrice(price);

    if (!symbol || !quantity || !price) {
      throw new Error("Datos inválidos");
    }

    const wallet = await getOrCreateWallet(userId, session);

    const leverage = wallet.leverageFactor || 1;
    const margin = (quantity * price) / leverage;

    if (wallet.balanceOwn < margin) {
      throw new Error("Fondos insuficientes");
    }

    // 🔥 RESTAR MARGEN
    wallet.balanceOwn -= margin;
    wallet.balance = wallet.balanceOwn;

    await wallet.save({ session });

    const position = await Position.create([{
      user: userId,
      symbol,
      side,
      qty: quantity,
      entryPrice: price,
      currentPrice: price,
      marginReserved: margin,
      status: "OPEN",
      pnl: 0,
    }], { session });

    await recalculateWalletMetrics(userId, session);

    await session.commitTransaction();

    return {
      ok: true,
      data: {
        positionId: position[0]._id,
        symbol,
        pnl: 0,
      },
    };

  } catch (err) {
    await session.abortTransaction();
    return { ok: false, error: err.message };
  } finally {
    session.endSession();
  }
};

// =======================
// 🔴 CLOSE TRADE (AQUÍ ESTÁ TU PROBLEMA)
// =======================
export const closeTrade = async ({ user, positionId, closePrice }) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = user._id;
    const price = normalizePrice(closePrice);

    const position = await Position.findOne({
      _id: positionId,
      user: userId,
      status: "OPEN",
    }).session(session);

    if (!position) throw new Error("Posición no encontrada");

    const wallet = await getOrCreateWallet(userId, session);

    const pnl = computePnl({
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: price,
      qty: position.qty,
    });

    const margin = Number(position.marginReserved || 0);

    // 🔥🔥🔥 ESTO ES LO QUE QUERÍAS
    // balance += margen + pnl
    wallet.balanceOwn = wallet.balanceOwn + margin + pnl;
    wallet.balance = wallet.balanceOwn;

    await wallet.save({ session });

    // cerrar posición
    position.status = "CLOSED";
    position.closePrice = price;
    position.pnl = pnl;

    await position.save({ session });

    await recalculateWalletMetrics(userId, session);

    await session.commitTransaction();

    return {
      ok: true,
      data: {
        pnl,
        balance: wallet.balanceOwn,
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
