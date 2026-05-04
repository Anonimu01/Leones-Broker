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

    let wallet = await Wallet.findOne({ user: userId }).session(session);

    if (!wallet) {
      const userDoc = await User.findById(userId).session(session).catch(() => null);

      wallet = new Wallet({
        user: userId,
        balanceOwn: Number(userDoc?.balance ?? 1000) || 1000,
        balance: Number(userDoc?.balance ?? 1000) || 1000,
        credit: 0,
        marginUsed: 0,
        leverageFactor: Number(userDoc?.leverage ?? 1) || 1,
        equity: Number(userDoc?.balance ?? 1000) || 1000,
        freeMargin: Number(userDoc?.balance ?? 1000) || 1000,
        marginLevel: 0,
      });

      await wallet.save({ session });
    }

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
        side,
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
