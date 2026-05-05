import Position from "../models/position.model.js";
import Wallet from "../models/wallet.model.js";
import User from "../models/user.model.js";
import mongoose from "mongoose";

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

function compactSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function sameMarketSymbol(a = "", b = "") {
  const x = compactSymbol(a);
  const y = compactSymbol(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function normalizeSide(value) {
  const side = String(value || "BUY").trim().toUpperCase();
  if (side === "SELL" || side === "SHORT") return "SELL";
  return "BUY";
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

  const isSell = String(side).toUpperCase() === "SELL";

  return isSell
    ? (entry - exit) * quantity
    : (exit - entry) * quantity;
}

// 🔥 WALLET SEGURO
async function getOrCreateWallet(userId, session = null) {
  let query = Wallet.findOne({ user: userId });
  if (session) query = query.session(session);

  let wallet = await query;

  if (!wallet) {
    let userQuery = User.findById(userId);
    if (session) userQuery = userQuery.session(session);

    const userDoc = await userQuery.catch(() => null);

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

async function findLatestKnownPriceForSymbol(symbol) {
  const target = normalizeSymbol(symbol);
  if (!target) return null;

  const rows = await Position.find({})
    .sort({ createdAt: -1 })
    .select("symbol currentPrice entryPrice price openPrice")
    .lean()
    .exec()
    .catch(() => []);

  for (const row of rows || []) {
    const rowSymbol = row?.symbol || "";
    if (!sameMarketSymbol(rowSymbol, target)) continue;

    const px =
      normalizePrice(row.currentPrice) ||
      normalizePrice(row.entryPrice) ||
      normalizePrice(row.price) ||
      normalizePrice(row.openPrice);

    if (px) return px;
  }

  return null;
}

function matchesAnySymbol(pos = {}, targetSymbol = "") {
  const candidates = [
    pos.symbol,
    pos.tvSymbol,
    pos.selectedSymbol,
    pos.chartSymbol,
    pos.instrument,
    pos.marketSymbol,
    pos.market,
    pos.ticker,
    pos.asset,
  ].filter(Boolean);

  return candidates.some((candidate) => sameMarketSymbol(candidate, targetSymbol));
}

// 🔥 RECALCULAR WALLET DESDE POSICIONES ABIERTAS
async function recalculateWalletMetrics(userId, session = null) {
  let walletQuery = Wallet.findOne({ user: userId });
  if (session) walletQuery = walletQuery.session(session);

  const wallet = await walletQuery;
  if (!wallet) return null;

  let positionsQuery = Position.find({
    user: userId,
    status: "OPEN",
  }).select("marginReserved pnl profit");

  if (session) positionsQuery = positionsQuery.session(session);

  const openPositions = await positionsQuery;

  const marginUsed = openPositions.reduce((sum, pos) => {
    return sum + (Number(pos.marginReserved) || 0);
  }, 0);

  const openPnl = openPositions.reduce((sum, pos) => {
    const value = pos.pnl ?? pos.profit ?? 0;
    return sum + (Number(value) || 0);
  }, 0);

  const balanceOwn = Number(wallet.balanceOwn) || 0;
  const credit = Number(wallet.credit) || 0;

  // balance = dinero disponible del usuario
  wallet.balance = balanceOwn;

  // margen total bloqueado por posiciones abiertas
  wallet.marginUsed = marginUsed;

  // equity = balance disponible + margen bloqueado + PnL flotante + crédito
  wallet.equity = balanceOwn + marginUsed + openPnl + credit;

  // freeMargin = balance disponible sin contar margen bloqueado
  wallet.freeMargin = balanceOwn + credit;

  wallet.marginLevel =
    wallet.marginUsed > 0
      ? (wallet.equity / wallet.marginUsed) * 100
      : 0;

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
    session ? { session } : {}
  ).catch(() => null);

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
      status: "OPEN",
    });

    const affectedUsers = new Set();

    for (const pos of positions) {
      if (!matchesAnySymbol(pos, cleanSymbol)) continue;

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

      if (pos.user) {
        affectedUsers.add(String(pos.user));
      }
    }

    for (const userId of affectedUsers) {
      await recalculateWalletMetrics(userId);
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
    const lastPrice = await findLatestKnownPriceForSymbol(symbol);

    if (lastPrice) {
      const diff = Math.abs(lastPrice - entryPrice);

      if (diff > lastPrice * 0.5) {
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

    const freeBalance = balanceOwn + credit;

    if (freeBalance < requiredMargin) {
      throw new Error("Fondos insuficientes");
    }

    // 🔥 BLOQUEAR MARGEN
    wallet.balanceOwn = balanceOwn - requiredMargin;
    wallet.balance = wallet.balanceOwn;
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

    const created = await Position.create(
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

    await recalculateWalletMetrics(userId, session);

    await session.commitTransaction();
    session.endSession();

    const position = created?.[0];

    return {
      ok: true,
      data: {
        positionId: position?._id || String(Date.now()),
        symbol,
        side,
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

    // =========================
    // 🔥 DEVOLVER MARGEN + PNL
    // balance += margen bloqueado + PnL realizado
    // =========================
    wallet.balanceOwn = Number(wallet.balanceOwn || 0) + margin + pnl;
    wallet.balance = wallet.balanceOwn;
    wallet.updatedAt = new Date();

    await wallet.save({ session });

    // =========================
    // 🔥 CERRAR POSICIÓN
    // =========================
    position.status = "CLOSED";
    position.closePrice = exitPrice;
    position.currentPrice = exitPrice;
    position.pnl = pnl;
    position.profit = pnl;
    position.closedAt = new Date();
    position.updatedAt = new Date();

    await position.save({ session });

    // Recalcula marginUsed, equity y freeMargin con las posiciones que quedan abiertas
    await recalculateWalletMetrics(userId, session);

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
