import Position from "../models/position.model.js";
import Wallet from "../models/wallet.model.js";
import User from "../models/user.model.js";
import mongoose from "mongoose";

// =======================
// 🔧 HELPERS ROBUSTOS
// =======================
function normalizePrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^OANDA:/, "")
    .replace(/^BINANCE:/, "")
    .replace(/^FOREX:/, "")
    .replace(/^NASDAQ:/, "")
    .replace(/^INDEX:/, "")
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeSide(value) {
  const side = String(value || "BUY").toUpperCase();
  return side === "SELL" ? "SELL" : "BUY";
}

// =======================
// 📌 PNL
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
// 📈 OPEN TRADE (FIX FINAL REAL)
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

    // ======================================================
    // 🔥 ENTRY PRICE FIX DEFINITIVO (AQUÍ VA TODO)
    // ======================================================
    let entryPrice = normalizePrice(price);

    // 🔥 1. precio desde priceHandler (tu stream principal)
    if (!entryPrice) {
      const store = global.priceHandler?.prices || {};

      entryPrice =
        normalizePrice(store[symbol]?.price) ||
        normalizePrice(store[normalizeSymbol(symbol)]?.price);
    }

    // 🔥 2. fallback global de mercado (si lo tienes)
    if (!entryPrice) {
      const market = global.marketData?.prices || {};

      entryPrice =
        normalizePrice(market[symbol]) ||
        normalizePrice(market[normalizeSymbol(symbol)]);
    }

    // ❌ BLOQUEO FINAL (OBLIGATORIO)
    if (!entryPrice) {
      await session.abortTransaction();
      session.endSession();

      return {
        ok: false,
        error: "price_not_available",
        symbol,
        receivedPrice: null,
      };
    }

    const wallet = await Wallet.findOne({ user: userId }).session(session);

    const leverage = Math.max(Number(wallet?.leverageFactor ?? 1), 1);
    const margin = (quantity * entryPrice) / leverage;

    const position = await Position.create(
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

    wallet.marginUsed = Number(wallet.marginUsed || 0) + margin;
    await wallet.save({ session });

    await session.commitTransaction();
    session.endSession();

    return { ok: true, data: position[0] };

  } catch (err) {
    await session.abortTransaction();
    session.endSession();

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

    if (!position) throw new Error("posición no encontrada");

    let exit = normalizePrice(closePrice);

    if (!exit) {
      const store = global.priceHandler?.prices || {};

      exit =
        normalizePrice(store[normalizeSymbol(position.symbol)]?.price) ||
        normalizePrice(position.entryPrice);
    }

    if (!exit) exit = 1;

    const pnl = computePnl({
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: exit,
      qty: position.qty,
    });

    const wallet = await Wallet.findOne({ user: userId }).session(session);

    wallet.balanceOwn = Number(wallet.balanceOwn || 0) + pnl;
    wallet.balance = wallet.balanceOwn;

    wallet.marginUsed = Math.max(
      0,
      Number(wallet.marginUsed || 0) - Number(position.marginReserved || 0)
    );

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
    session.endSession();

    return {
      ok: true,
      data: { pnl, balance: wallet.balanceOwn, closePrice: exit },
    };

  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    return { ok: false, error: err.message };
  }
};

export default {
  openTrade,
  closeTrade,
};
