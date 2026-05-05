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

  if (!Number.isFinite(entry) || entry <= 0) return 0;
  if (!Number.isFinite(exit) || exit <= 0) return 0;
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;

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

    const initialBalance = Number(userDoc?.balance ?? 1000) || 1000;
    const initialCredit = Number(userDoc?.credit ?? 0) || 0;

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

// =======================
// 🔥 RECALCULO
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
  wallet.equity = balanceOwn + pnlFloating + credit;
  wallet.freeMargin = wallet.equity - marginUsed;
  wallet.updatedAt = new Date();

  await wallet.save({ session });

  await User.updateOne(
    { _id: userId },
    { $set: { balance: wallet.balanceOwn, updatedAt: new Date() } },
    session ? { session } : {}
  ).catch(() => null);
}

// =======================
// 📈 UPDATE LIVE PRICE
// =======================
export const updateLivePrice = async ({ symbol, price }) => {
  try {
    const livePrice = normalizePrice(price);
    if (!livePrice) return;

    const cleanSymbol = normalizeSymbol(symbol);

    const positions = await Position.find({ status: "OPEN" });

    const users = new Set();

    for (const pos of positions) {
      if (normalizeSymbol(pos.symbol) !== cleanSymbol) continue;

      const pnl = computePnl({
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice: livePrice,
        qty: pos.qty,
      });

      pos.currentPrice = livePrice;
      pos.pnl = pnl;
      pos.profit = pnl;
      pos.updatedAt = new Date();

      await pos.save();

      users.add(String(pos.user));
    }

    for (const u of users) {
      await recalculateWallet(u);
    }

  } catch (err) {
    console.error("❌ updateLivePrice error:", err);
  }
};

// =======================
// 🚀 OPEN TRADE (CORREGIDO)
// =======================
export const openTrade = async ({ user, order }) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = user?._id || user?.id;
    if (!userId) throw new Error("Usuario inválido");

    let { symbol, side, type, quantity, price } = order || {};

    symbol = normalizeSymbol(symbol);
    side = normalizeSide(side);
    type = String(type || "MARKET").toUpperCase();
    quantity = Number(quantity);

    let entryPrice = normalizePrice(price);

    // 🔥 AQUÍ ESTÁ LA CORRECCIÓN IMPORTANTE
    if (!entryPrice) {
      await session.abortTransaction();
      session.endSession();

      console.error("❌ No se puede abrir operación sin precio real");
      return { ok: false, error: "Precio de mercado inválido" };
    }

    const wallet = await getOrCreateWallet(userId, session);

    const leverage = Math.max(Number(wallet.leverageFactor ?? 1), 1);
    const margin = (quantity * entryPrice) / leverage;

    wallet.marginUsed = Number(wallet.marginUsed || 0) + margin;
    wallet.updatedAt = new Date();

    await wallet.save({ session });

    const position = await Position.create(
      [{
        user: userId,
        symbol,
        side,
        type,
        qty: quantity,
        entryPrice,
        currentPrice: entryPrice,
        marginReserved: margin,
        leverage,
        status: "OPEN",
        pnl: 0,
        profit: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      { session }
    );

    await recalculateWallet(userId, session);

    await session.commitTransaction();
    session.endSession();

    return { ok: true, data: position[0] };

  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    console.error("❌ OPEN ERROR:", err);

    return { ok: false, error: err.message };
  }
};

// =======================
// 🔴 CLOSE TRADE
// =======================
export const closeTrade = async ({ user, positionId, closePrice }) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = user?._id || user?.id;
    if (!userId) throw new Error("Usuario inválido");

    const position = await Position.findOne({
      _id: positionId,
      user: userId,
      status: "OPEN",
    }).session(session);

    if (!position) throw new Error("posicion no encontrada");

    const wallet = await getOrCreateWallet(userId, session);

    let exit = normalizePrice(closePrice);

    if (!exit) {
      await session.abortTransaction();
      session.endSession();

      console.error("❌ closePrice inválido");
      return { ok: false, error: "Precio de cierre inválido" };
    }

    const pnl = computePnl({
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: exit,
      qty: position.qty,
    });

    const margin = Number(position.marginReserved || 0);

    const newBalance = Number(wallet.balanceOwn || 0) + pnl;

    wallet.balanceOwn = newBalance;
    wallet.balance = newBalance;
    wallet.marginUsed = Math.max(0, Number(wallet.marginUsed || 0) - margin);
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

    await recalculateWallet(userId, session);

    await session.commitTransaction();
    session.endSession();

    return {
      ok: true,
      data: { pnl, balance: newBalance, closePrice: exit },
    };

  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    console.error("❌ CLOSE ERROR:", err);

    return { ok: false, error: err.message };
  }
};

export default {
  openTrade,
  closeTrade,
  updateLivePrice,
};
