import Position from "../models/position.model.js";
import Wallet from "../models/wallet.model.js";
import User from "../models/user.model.js";
import mongoose from "mongoose";

function normalizePrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeSymbol(value) {
  return String(value || "").trim().toUpperCase().replace(/^OANDA:/, "");
}

function normalizeSide(value) {
  const side = String(value || "BUY").trim().toUpperCase();
  if (side === "SELL" || side === "SHORT") return "SHORT";
  return "LONG";
}

function normalizeType(value) {
  return String(value || "MARKET").trim().toUpperCase();
}

// 🔥 PNL REAL
function computePnl({ side, entryPrice, exitPrice, qty }) {
  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  const quantity = Number(qty);

  if (!Number.isFinite(entry) || entry <= 0) return 0;
  if (!Number.isFinite(exit) || exit <= 0) return 0;
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;

  const isShort = String(side).toUpperCase() === "SHORT";

  return isShort
    ? (entry - exit) * quantity
    : (exit - entry) * quantity;
}

// 🔥 WALLET SEGURO
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

// =======================
// 📈 UPDATE LIVE PRICE
// =======================
export const updateLivePrice = async ({ symbol, price }) => {
  try {
    const livePrice = normalizePrice(price);
    if (!livePrice) return { ok: false, error: "Precio inválido" };

    const cleanSymbol = normalizeSymbol(symbol);

    const positions = await Position.find({
      symbol: cleanSymbol,
      status: "OPEN",
    });

    for (const pos of positions) {
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
    }

    return { ok: true };
  } catch (err) {
    console.error("❌ updateLivePrice error:", err);
    return { ok: false, error: err?.message || "server_error" };
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
    type = normalizeType(type);
    quantity = Number(quantity);

    const entryPrice = normalizePrice(price);

    if (!symbol || !Number.isFinite(quantity) || quantity <= 0) {
      throw new Error("Datos inválidos");
    }

    // =======================
    // 🔥 VALIDACIÓN BASE
    // =======================
    if (!entryPrice || entryPrice <= 0) {
      throw new Error("Precio de mercado inválido");
    }

    if (entryPrice === 1) {
      throw new Error("Precio inválido (fallback detectado)");
    }

    if (entryPrice < 0.0001) {
      throw new Error("Precio demasiado bajo (sync inválido)");
    }

    // =======================
    // 🔥 VALIDACIÓN CONTRA MERCADO REAL
    // =======================
    const lastPrice = await Position.findOne({ symbol })
      .sort({ createdAt: -1 })
      .select("currentPrice")
      .lean();

    if (lastPrice?.currentPrice) {
      const diff = Math.abs(lastPrice.currentPrice - entryPrice);

      if (diff > lastPrice.currentPrice * 0.5) {
        throw new Error("Precio fuera de rango de mercado");
      }
    }

    // 🔥 ANTI DUPLICADO REAL (OBLIGATORIO)
    const existingOpen = await Position.findOne({
      user: userId,
      symbol,
      status: "OPEN",
    }).session(session);

    if (existingOpen) {
      await session.abortTransaction();
      session.endSession();

      return {
        ok: false,
        error: "Ya tienes una operación abierta en este símbolo",
      };
    }

    const wallet = await getOrCreateWallet(userId, session);

    const leverage = Math.max(Number(wallet.leverageFactor ?? 1), 1);

    const notional = quantity * entryPrice;
    const requiredMargin = notional / leverage;

    const balanceOwn = Number(wallet.balanceOwn) || 0;
    const credit = Number(wallet.credit) || 0;
    const marginUsed = Number(wallet.marginUsed) || 0;

    const freeBalance = balanceOwn + credit - marginUsed;

    if (freeBalance < requiredMargin) {
      throw new Error("Fondos insuficientes");
    }

    // 🔥 BLOQUEAR MARGEN
    wallet.balanceOwn = balanceOwn - requiredMargin;
    wallet.marginUsed = marginUsed + requiredMargin;

    wallet.balance = wallet.balanceOwn;
    wallet.equity = wallet.balanceOwn + wallet.marginUsed + credit;
    wallet.freeMargin = wallet.balanceOwn + credit - wallet.marginUsed;
    wallet.marginLevel =
      wallet.marginUsed > 0
        ? (wallet.equity / wallet.marginUsed) * 100
        : 0;

    wallet.updatedAt = new Date();

    await wallet.save({ session });

    await User.updateOne(
      { _id: userId },
      { $set: { balance: wallet.balanceOwn, updatedAt: new Date() } },
      { session }
    ).catch(() => null);

    const positionDoc = await Position.create(
      [
        {
          user: userId,
          symbol,
          side,
          type,
          qty: quantity,
          entryPrice,
          currentPrice: entryPrice,
          marginReserved: requiredMargin,
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

    await session.commitTransaction();
    session.endSession();

    const position = positionDoc[0];

    return {
      ok: true,
      data: {
        positionId: position._id,
        symbol,
        side: position.side,
        qty: quantity,
        entryPrice,
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

// =======================
// 🔴 CLOSE TRADE
// =======================
export const closeTrade = async ({ user, positionId, closePrice }) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = user?._id || user?.id;
    if (!userId) throw new Error("Usuario inválido");

    const exitPrice = normalizePrice(closePrice);
    if (!exitPrice) throw new Error("Precio inválido");

    const position = await Position.findOne({
      _id: positionId,
      user: userId,
      status: "OPEN",
    }).session(session);

    if (!position) {
      throw new Error("Posición no encontrada");
    }

    const wallet = await getOrCreateWallet(userId, session);

    const entryPrice = Number(position.entryPrice);
    const qty = Number(position.qty);
    const side = position.side;
    const margin = Number(position.marginReserved || 0);

    const pnl = computePnl({
      side,
      entryPrice,
      exitPrice,
      qty,
    });

    wallet.marginUsed = Math.max(Number(wallet.marginUsed || 0) - margin, 0);
    wallet.balanceOwn = Number(wallet.balanceOwn || 0) + margin + pnl;

    wallet.balance = wallet.balanceOwn;

    const credit = Number(wallet.credit || 0);

    wallet.equity = wallet.balanceOwn + wallet.marginUsed + credit;
    wallet.freeMargin = wallet.balanceOwn + credit - wallet.marginUsed;
    wallet.marginLevel =
      wallet.marginUsed > 0
        ? (wallet.equity / wallet.marginUsed) * 100
        : 0;

    wallet.updatedAt = new Date();

    await wallet.save({ session });

    await User.updateOne(
      { _id: userId },
      { $set: { balance: wallet.balanceOwn, updatedAt: new Date() } },
      { session }
    ).catch(() => null);

    position.status = "CLOSED";
    position.closePrice = exitPrice;
    position.currentPrice = exitPrice;
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
        positionId,
        pnl,
        closePrice: exitPrice,
        balance: wallet.balanceOwn,
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
  updateLivePrice,
  openTrade,
  closeTrade,
};
