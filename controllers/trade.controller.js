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

// =======================
// 🔥 SYMBOL NORMALIZER
// =======================
function normalizeSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^OANDA:/, "")
    .replace(/^BINANCE:/, "")
    .replace(/^FOREX:/, "")
    .replace(/^NASDAQ:/, "")
    .replace(/^INDEX:/, "")
    .replace(/[^A-Z0-9:]/g, "");
}

function normalizeSide(value) {
  const side = String(value || "BUY").toUpperCase();
  return side === "SELL" ? "SELL" : "BUY";
}

// =======================
// 🔥 GLOBAL PRICE CACHE (CRÍTICO)
// =======================
const priceCache = global.priceCache || (global.priceCache = {});

// =======================
// 📡 MARKET PRICE ENGINE (FIX DEFINITIVO)
// =======================
function getMarketPrice(symbol) {
  const clean = normalizeSymbol(symbol);

  // 1. CACHE LOCAL (PRIORIDAD)
  const cached = normalizePrice(priceCache[clean]);
  if (cached) return cached;

  const sources = [
    global.priceHandler?.prices,
    global.marketData?.prices,
    global.quotes?.prices,
  ];

  for (const src of sources) {
    if (!src) continue;

    const price =
      normalizePrice(src?.[clean]?.price) ||
      normalizePrice(src?.[clean]) ||
      normalizePrice(src?.[symbol]?.price) ||
      normalizePrice(src?.[symbol]);

    if (price) {
      priceCache[clean] = price;
      return price;
    }
  }

  return null;
}

// =======================
// 📈 PNL
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
// 💰 WALLET
// =======================
async function getOrCreateWallet(userId, session) {
  let wallet = await Wallet.findOne({ user: userId }).session(session);

  if (!wallet) {
    const userDoc = await User.findById(userId).session(session).catch(() => null);

    wallet = new Wallet({
      user: userId,
      balanceOwn: Number(userDoc?.balance || 1000),
      balance: Number(userDoc?.balance || 1000),
      credit: Number(userDoc?.credit || 0),
      marginUsed: 0,
      equity: Number(userDoc?.balance || 1000),
      freeMargin: Number(userDoc?.balance || 1000),
    });

    await wallet.save({ session });
  }

  return wallet;
}

// =======================
// 📊 RECALC WALLET
// =======================
async function recalc(userId, session) {
  const wallet = await Wallet.findOne({ user: userId }).session(session);
  if (!wallet) return;

  const positions = await Position.find({
    user: userId,
    status: "OPEN",
  }).session(session);

  let margin = 0;
  let pnl = 0;

  for (const p of positions) {
    margin += Number(p.marginReserved || 0);
    pnl += Number(p.pnl || 0);
  }

  wallet.marginUsed = margin;
  wallet.equity = wallet.balanceOwn + pnl + wallet.credit;
  wallet.freeMargin = wallet.equity - margin;

  await wallet.save({ session });
}

// =======================
// 🚀 OPEN TRADE (FIX FINAL ESTABLE)
// =======================
export const openTrade = async ({ user, order }) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = user?._id || user?.id;
    if (!userId) throw new Error("invalid_user");

    let { symbol, side, quantity, price, type } = order;

    symbol = normalizeSymbol(symbol);
    side = normalizeSide(side);
    quantity = Number(quantity);

    // =========================
    // 🔥 PRICE ENGINE ROBUSTO
    // =========================
    let entryPrice = normalizePrice(price);

    // 1. precio desde frontend
    if (entryPrice) {
      priceCache[symbol] = entryPrice;
    }

    // 2. cache
    if (!entryPrice) {
      entryPrice = normalizePrice(priceCache[symbol]);
    }

    // 3. market engine
    if (!entryPrice) {
      entryPrice = getMarketPrice(symbol);
    }

    // 4. FALLBACK FINAL (EVITA CRASH)
    if (!entryPrice) {
      console.warn("⚠️ fallback price usado:", symbol);
      entryPrice = 1; // evita bloqueo total del sistema
    }

    priceCache[symbol] = entryPrice;

    const wallet = await getOrCreateWallet(userId, session);

    const leverage = 1;
    const margin = (quantity * entryPrice) / leverage;

    wallet.marginUsed += margin;

    await wallet.save({ session });

    const position = await Position.create(
      [
        {
          user: userId,
          symbol,
          side,
          type: type || "MARKET",
          qty: quantity,
          entryPrice,
          currentPrice: entryPrice,
          marginReserved: margin,
          pnl: 0,
          status: "OPEN",
        },
      ],
      { session }
    );

    await recalc(userId, session);

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

    const position = await Position.findById(positionId).session(session);
    if (!position) throw new Error("position_not_found");

    let exit =
      normalizePrice(closePrice) ||
      getMarketPrice(position.symbol) ||
      position.entryPrice;

    const pnl = computePnl({
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: exit,
      qty: position.qty,
    });

    const wallet = await getOrCreateWallet(userId, session);

    wallet.balanceOwn += pnl;
    wallet.balance = wallet.balanceOwn;

    await wallet.save({ session });

    position.status = "CLOSED";
    position.closePrice = exit;
    position.pnl = pnl;

    await position.save({ session });

    await recalc(userId, session);

    await session.commitTransaction();
    session.endSession();

    return { ok: true, pnl, balance: wallet.balanceOwn };

  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    return { ok: false, error: err.message };
  }
};

// =======================
// 📡 LIVE PRICE UPDATE
// =======================
export const updateLivePrice = async ({ symbol, price }) => {
  try {
    const clean = normalizeSymbol(symbol);
    const live = normalizePrice(price);
    if (!live) return;

    priceCache[clean] = live;

    const positions = await Position.find({ status: "OPEN" });

    for (const p of positions) {
      if (normalizeSymbol(p.symbol) !== clean) continue;

      const pnl = computePnl({
        side: p.side,
        entryPrice: p.entryPrice,
        exitPrice: live,
        qty: p.qty,
      });

      p.currentPrice = live;
      p.pnl = pnl;

      await p.save();
    }
  } catch (e) {
    console.error("updateLivePrice error:", e);
  }
};

// =======================
// EXPORT
// =======================
export default {
  openTrade,
  closeTrade,
  updateLivePrice,
};
