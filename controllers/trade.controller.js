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

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeEndSession(session) {
  try {
    if (session) session.endSession();
  } catch {
    // noop
  }
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
  let query = Wallet.findOne({ user: userId });
  if (session) query = query.session(session);

  let wallet = await query;

  if (!wallet) {
    let userDocQuery = User.findById(userId);
    if (session) userDocQuery = userDocQuery.session(session);

    const userDoc = await userDocQuery.catch(() => null);

    const initialBalance = toNumber(userDoc?.balance, 1000) || 1000;
    const initialCredit = toNumber(userDoc?.credit, 0) || 0;

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

    await wallet.save(session ? { session } : {});
  }

  return wallet;
}

// =======================
// 🔥 RECALCULO
// =======================
async function recalculateWallet(userId, session = null) {
  let walletQuery = Wallet.findOne({ user: userId });
  if (session) walletQuery = walletQuery.session(session);

  const wallet = await walletQuery;
  if (!wallet) return;

  let positionsQuery = Position.find({
    user: userId,
    status: "OPEN",
  });
  if (session) positionsQuery = positionsQuery.session(session);

  const openPositions = await positionsQuery;

  let marginUsed = 0;
  let pnlFloating = 0;

  for (const pos of openPositions) {
    marginUsed += toNumber(pos.marginReserved, 0);
    pnlFloating += toNumber(pos.pnl, 0);
  }

  const balanceOwn = toNumber(wallet.balanceOwn, 0);
  const credit = toNumber(wallet.credit, 0);

  wallet.marginUsed = marginUsed;
  wallet.equity = balanceOwn + pnlFloating + credit;
  wallet.freeMargin = wallet.equity - marginUsed;
  wallet.marginLevel = marginUsed > 0 ? (wallet.equity / marginUsed) * 100 : 0;
  wallet.updatedAt = new Date();

  await wallet.save(session ? { session } : {});

  await User.updateOne(
    { _id: userId },
    {
      $set: {
        balance: wallet.balanceOwn,
        updatedAt: new Date(),
      },
    },
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
    if (!cleanSymbol) return;

    const positions = await Position.find({ status: "OPEN" });
    const users = new Set();

    for (const pos of positions) {
      if (normalizeSymbol(pos.symbol) !== cleanSymbol) continue;

      const pnl = computePnl({
        side: normalizeSide(pos.side),
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
// 🚀 OPEN TRADE
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

    if (!symbol) throw new Error("Símbolo inválido");
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error("Cantidad inválida");
    }

    let entryPrice = normalizePrice(price);

    // 🔥 FALLBACK CONTROLADO
    if (!entryPrice) {
      console.warn("⚠️ Precio inválido en apertura → usando 1");
      entryPrice = 1;
    }

    const wallet = await getOrCreateWallet(userId, session);

    const leverage = Math.max(toNumber(wallet.leverageFactor, 1), 1);
    const margin = (quantity * entryPrice) / leverage;

    if (!Number.isFinite(margin) || margin < 0) {
      throw new Error("Margen inválido");
    }

    wallet.marginUsed = toNumber(wallet.marginUsed, 0) + margin;
    wallet.updatedAt = new Date();

    await wallet.save({ session });

    const positionDocs = await Position.create(
      [
        {
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
        },
      ],
      { session }
    );

    await recalculateWallet(userId, session);

    await session.commitTransaction();
    safeEndSession(session);

    return { ok: true, data: positionDocs[0] };
  } catch (err) {
    await session.abortTransaction().catch(() => null);
    safeEndSession(session);

    console.error("❌ OPEN ERROR:", err);
    return { ok: false, error: err.message };
  }
};

// =======================
// 🔴 CLOSE TRADE
// =======================
export const closeTrade = async ({ user, positionId, closePrice, price }) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = user?._id || user?.id;
    if (!userId) throw new Error("Usuario inválido");
    if (!positionId) throw new Error("positionId requerido");

    let positionQuery = Position.findOne({
      _id: positionId,
      user: userId,
      status: "OPEN",
    }).session(session);

    const position = await positionQuery;

    if (!position) {
      throw new Error("Posición no encontrada o ya cerrada");
    }

    const wallet = await getOrCreateWallet(userId, session);

    let exit = normalizePrice(closePrice ?? price);

    // 🔥 SI NO VIENE PRECIO, USAMOS EL ENTRY PARA NO ROMPER
    if (!exit) {
      console.warn("⚠️ closePrice inválido → usando entryPrice");
      exit = normalizePrice(position.entryPrice) || 1;
    }

    const pnl = computePnl({
      side: normalizeSide(position.side),
      entryPrice: position.entryPrice,
      exitPrice: exit,
      qty: position.qty,
    });

    const margin = toNumber(position.marginReserved, 0);

    // 🔥 Actualizar balance real: balanceOwn + pnl
    const newBalance = toNumber(wallet.balanceOwn, 0) + pnl;

    wallet.balanceOwn = newBalance;
    wallet.balance = newBalance;
    wallet.marginUsed = Math.max(0, toNumber(wallet.marginUsed, 0) - margin);
    wallet.updatedAt = new Date();

    await wallet.save({ session });

    // 🔴 CERRAR POSICIÓN
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

    console.error("❌ CLOSE ERROR REAL:", err);
    return { ok: false, error: err.message };
  }
};

export default {
  openTrade,
  closeTrade,
  updateLivePrice,
};
