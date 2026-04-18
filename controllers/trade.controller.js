import Position from "../models/position.model.js";
import Wallet from "../models/wallet.model.js";
import mongoose from "mongoose";

export const openTrade = async ({ user, order }) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = user._id || user.id;

    let { symbol, side, type, quantity, price } = order;

    quantity = Number(quantity);
    price = Number(price || 0);
    side = String(side || "BUY").toUpperCase();
    type = String(type || "MARKET").toUpperCase();

    if (!symbol || !quantity) {
      throw new Error("Datos inválidos");
    }

    // 🔥 BUSCAR WALLET
    let wallet = await Wallet.findOne({ user: userId }).session(session);

    if (!wallet) {
      wallet = await Wallet.create([{
        user: userId,
        balanceOwn: 1000, // saldo inicial si no existe
        credit: 0,
        marginUsed: 0,
        leverageFactor: 1
      }], { session });

      wallet = wallet[0];
    }

    const leverage = wallet.leverageFactor || 1;

    const notional = quantity * (price || 1);
    const requiredMargin = notional / leverage;

    const freeBalance = wallet.balanceOwn;

    // ❌ SIN FONDOS
    if (freeBalance < requiredMargin) {
      throw new Error("Fondos insuficientes");
    }

    // 🔥 DESCONTAR DINERO REAL (ESTO TE FALTABA)
    wallet.balanceOwn -= requiredMargin;
    wallet.marginUsed += requiredMargin;

    await wallet.save({ session });

    // 🔥 CREAR POSICIÓN REAL
    const position = await Position.create([{
      user: userId,
      symbol,
      side: side === "SELL" ? "SHORT" : "LONG",
      qty: quantity,
      entryPrice: price || 0,
      currentPrice: price || 0,
      marginReserved: requiredMargin,
      status: "OPEN",
      profit: 0,
      createdAt: new Date()
    }], { session });

    await session.commitTransaction();
    session.endSession();

    return {
      ok: true,
      data: {
        positionId: position[0]._id,
        symbol,
        side,
        qty: quantity,
        entryPrice: price,
        margin: requiredMargin
      }
    };

  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    return {
      ok: false,
      error: err.message
    };
  }
};
