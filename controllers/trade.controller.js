import Position from "../models/position.model.js";
import Wallet from "../models/wallet.model.js";
import User from "../models/user.model.js";
import mongoose from "mongoose";

function normalizePrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeSide(value) {
  return String(value || "BUY").trim().toUpperCase();
}

function normalizeType(value) {
  return String(value || "MARKET").trim().toUpperCase();
}

function computePnl({ side, entryPrice, exitPrice, qty }) {
  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  const quantity = Number(qty);

  if (!Number.isFinite(entry) || entry <= 0) return 0;
  if (!Number.isFinite(exit) || exit <= 0) return 0;
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;

  const isShort = String(side || "").toUpperCase() === "SHORT";
  return isShort ? (entry - exit) * quantity : (exit - entry) * quantity;
}

async function getOrCreateWallet(userId, session) {
  let wallet = await Wallet.findOne({ user: userId }).session(session);

  if (!wallet) {
    const userDoc = await User.findById(userId).session(session).catch(() => null);
    const initialBalance = Number(userDoc?.balance ?? 1000) || 1000;
    const initialLeverage = Number(userDoc?.leverage ?? 1) || 1;

    wallet = new Wallet({
      user: userId,
      balanceOwn: initialBalance,
      balance: initialBalance,
      credit: 0,
      marginUsed: 0,
      leverageFactor: initialLeverage,
      equity: initialBalance,
      freeMargin: initialBalance,
      marginLevel: 0,
    });

    await wallet.save({ session });
  }

  return wallet;
}

export const openTrade = async ({ user, order }) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = user?._id || user?.id;
    if (!userId) {
      throw new Error("Usuario inválido");
    }

    let { symbol, side, type, quantity, price } = order || {};

    symbol = String(symbol || "").trim().toUpperCase();
    side = normalizeSide(side);
    type = normalizeType(type);
    quantity = Number(quantity);

    const entryPrice = normalizePrice(price);

    if (!symbol || !Number.isFinite(quantity) || quantity <= 0) {
      throw new Error("Datos inválidos");
    }

    if (!entryPrice) {
      throw new Error("Precio inválido");
    }

    const wallet = await getOrCreateWallet(userId, session);

    const leverage = Math.max(Number(wallet.leverageFactor ?? 1) || 1, 1);
    const notional = quantity * entryPrice;
    const requiredMargin = notional / leverage;

    const balanceOwn = Number(wallet.balanceOwn ?? wallet.balance ?? 0) || 0;
    const credit = Number(wallet.credit ?? 0) || 0;
    const marginUsed = Number(wallet.marginUsed ?? 0) || 0;
    const freeBalance = balanceOwn + credit - marginUsed;

    if (freeBalance < requiredMargin) {
      throw new Error("Fondos insuficientes");
    }

    wallet.balanceOwn = balanceOwn - requiredMargin;
    wallet.balance = wallet.balanceOwn;
    wallet.marginUsed = marginUsed + requiredMargin;
    wallet.equity = wallet.balanceOwn + wallet.marginUsed + credit;
    wallet.freeMargin = Math.max(wallet.balanceOwn + credit, 0);
    wallet.marginLevel = wallet.marginUsed > 0 ? (wallet.equity / wallet.marginUsed) * 100 : 0;
    wallet.updatedAt = new Date();

    await wallet.save({ session });

    await User.updateOne(
      { _id: userId },
      {
        $set: {
          balance: wallet.balanceOwn,
          leverage: leverage,
          updatedAt: new Date(),
        },
      },
      { session }
    ).catch(() => null);

    const positionDoc = await Position.create(
      [
        {
          user: userId,
          symbol,
          side: side === "SELL" ? "SHORT" : "LONG",
          qty: quantity,
          entryPrice,
          currentPrice: entryPrice,
          marginReserved: requiredMargin,
          leverage,
          status: "OPEN",
          profit: 0,
          pnl: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    const position = positionDoc[0];

    return {
      ok: true,
      data: {
        positionId: position._id,
        symbol,
        side: side === "SELL" ? "SHORT" : "LONG",
        qty: quantity,
        entryPrice,
        currentPrice: entryPrice,
        margin: requiredMargin,
        leverage,
        status: "OPEN",
        pnl: 0,
      },
    };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    return {
      ok: false,
      error: err?.message || "server_error",
    };
  }
};

export const closeTrade = async ({ user, positionId, closePrice }) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = user?._id || user?.id;
    if (!userId) {
      throw new Error("Usuario inválido");
    }

    const exitPrice = normalizePrice(closePrice);
    if (!exitPrice) {
      throw new Error("Precio de cierre inválido");
    }

    const position = await Position.findOne({
      _id: positionId,
      user: userId,
      status: { $in: ["OPEN", "open", "Open"] },
    }).session(session);

    if (!position) {
      throw new Error("Posición no encontrada o ya cerrada");
    }

    const wallet = await getOrCreateWallet(userId, session);

    const entryPrice = Number(position.entryPrice ?? 0) || 0;
    const qty = Number(position.qty ?? 0) || 0;
    const side = String(position.side || "LONG").toUpperCase();
    const marginReserved = Number(position.marginReserved ?? 0) || 0;

    const pnl = computePnl({
      side,
      entryPrice,
      exitPrice,
      qty,
    });

    const balanceBefore = Number(wallet.balanceOwn ?? wallet.balance ?? 0) || 0;
    const marginUsedBefore = Number(wallet.marginUsed ?? 0) || 0;
    const credit = Number(wallet.credit ?? 0) || 0;

    wallet.marginUsed = Math.max(marginUsedBefore - marginReserved, 0);
    wallet.balanceOwn = balanceBefore + marginReserved + pnl;
    wallet.balance = wallet.balanceOwn;
    wallet.equity = wallet.balanceOwn + wallet.marginUsed + credit;
    wallet.freeMargin = Math.max(wallet.balanceOwn + credit - wallet.marginUsed, 0);
    wallet.marginLevel = wallet.marginUsed > 0 ? (wallet.equity / wallet.marginUsed) * 100 : 0;
    wallet.updatedAt = new Date();

    await wallet.save({ session });

    await User.updateOne(
      { _id: userId },
      {
        $set: {
          balance: wallet.balanceOwn,
          updatedAt: new Date(),
        },
      },
      { session }
    ).catch(() => null);

    position.status = "CLOSED";
    position.currentPrice = exitPrice;
    position.closePrice = exitPrice;
    position.realizedPnl = pnl;
    position.pnl = pnl;
    position.profit = pnl;
    position.closedAt = new Date();
    position.updatedAt = new Date();

    await position.save({ session });

    await session.commitTransaction();
    session.endSession();

    return {
      ok: true,
      data: {
        positionId: position._id,
        symbol: position.symbol,
        side,
        qty,
        entryPrice,
        closePrice: exitPrice,
        pnl,
        marginReleased: marginReserved,
        balance: wallet.balanceOwn,
        marginUsed: wallet.marginUsed,
      },
    };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    return {
      ok: false,
      error: err?.message || "server_error",
    };
  }
};

export default {
  openTrade,
  closeTrade,
};
