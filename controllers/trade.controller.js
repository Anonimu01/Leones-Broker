import Position from "../models/position.model.js";
import Wallet from "../models/wallet.model.js";
import { executeOrderOnBroker } from "../services/market.js"; // implementaremos esto
import mongoose from "mongoose";

/**
 * POST /trade/open
 * body: { symbol, qty, price, side, type, clientOrderId? }
 *
 * Behaviour:
 * - Verifica wallet y margen
 * - Reserva margen
 * - Si TRADING_MODE === 'live' llama al broker a través de services/market.js
 * - Si TRADING_MODE === 'paper' solo crea la posición localmente (simula ejecución)
 * - Guarda respuesta del broker en la posición
 * - Maneja idempotencia con header 'Idempotency-Key' o body.clientOrderId (mejor usar Redis en producción)
 */

const IDEMPOTENCY_MAP = new Map(); // -> usar Redis en producción

export const openTrade = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      await session.abortTransaction();
      session.endSession();
      return res.status(401).json({ ok:false, msg: "Usuario no autenticado" });
    }

    let { symbol, qty, price, side, type } = req.body;
    qty = Number(qty || 0);
    price = Number(price || 0);
    side = (side || "BUY").toString().toUpperCase();
    type = (type || "market").toString().toLowerCase();

    if (!symbol || !qty || (type === "limit" && !price)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ ok:false, msg: "symbol, qty y price (si limit) son obligatorios" });
    }

    // Idempotency key (header preferred)
    const idemHeader = req.headers["idempotency-key"] || req.body.clientOrderId || null;
    const idemKey = idemHeader ? `${userId}::${String(idemHeader)}` : null;
    if (idemKey && IDEMPOTENCY_MAP.has(idemKey)) {
      const cached = IDEMPOTENCY_MAP.get(idemKey);
      await session.commitTransaction();
      session.endSession();
      return res.status(200).json({ ok:true, idempotent: true, data: cached });
    }

    // obtener wallet o crear si no existe
    let wallet = await Wallet.findOne({ user: userId }).session(session);
    if (!wallet) {
      wallet = await Wallet.create([{ user: userId, balanceOwn: 0, credit: 0, marginUsed: 0, leverageFactor: 1 }], { session });
      wallet = wallet[0];
    }

    const leverage = Number(wallet.leverageFactor || 1);
    const notional = Math.abs(qty * (type === "market" ? (price || 0) : price || 0));
    const requiredMargin = notional / Math.max(1, leverage);
    const freeMargin = (wallet.balanceOwn || 0) + (wallet.credit || 0) - (wallet.marginUsed || 0);

    if (freeMargin < requiredMargin) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ ok:false, msg: "Fondos insuficientes para abrir la operación", freeMargin, requiredMargin });
    }

    // Reserve margin immediately (optimista) to avoid race conditions
    wallet.marginUsed = (wallet.marginUsed || 0) + requiredMargin;
    await wallet.save({ session });

    // Build local position (status PENDING while broker processes)
    const pos = await Position.create([{
      user: userId,
      symbol,
      side: (side === "SELL" || side === "SHORT") ? "SHORT" : "LONG",
      qty,
      entryPrice: price || 0,
      currentPrice: price || 0,
      marginReserved: requiredMargin,
      status: "PENDING",
      clientOrderId: idemHeader || null,
      brokerOrderId: null,
      brokerResponse: null,
      createdAt: new Date()
    }], { session });

    const position = pos[0];

    // Decide mode: paper or live
    const MODE = (process.env.TRADING_MODE || "paper").toLowerCase(); // 'paper' or 'live'

    let brokerResult = null;

    if (MODE === "live") {
      // Call market service to execute real order
      // executeOrderOnBroker should return: { ok:true, data: { brokerOrderId, executedQty, avgPrice, raw } } or { ok:false, error }
      brokerResult = await executeOrderOnBroker({
        userId,
        symbol,
        side,
        type,
        quantity: qty,
        price: type === "limit" ? price : undefined,
        clientOrderId: idemHeader || undefined
      });

      if (!brokerResult || !brokerResult.ok) {
        // Rollback: free margin reserved
        wallet.marginUsed = Math.max(0, (wallet.marginUsed || 0) - requiredMargin);
        await wallet.save({ session });

        // Mark position as FAILED and store response if any
        position.status = "FAILED";
        position.brokerResponse = brokerResult && brokerResult.raw ? brokerResult.raw : { error: brokerResult && brokerResult.error ? brokerResult.error : 'broker error' };
        await position.save({ session });

        await session.commitTransaction();
        session.endSession();

        return res.status(502).json({ ok:false, msg: "Error ejecutando en broker", error: brokerResult && brokerResult.error ? brokerResult.error : null });
      }

      // Broker succeeded — update position as OPEN/FILLED depending on response
      const d = brokerResult.data || {};
      position.status = d.status || "OPEN";
      position.entryPrice = d.avgPrice || position.entryPrice || price || 0;
      position.currentPrice = d.avgPrice || position.currentPrice || price || 0;
      position.brokerOrderId = d.brokerOrderId || null;
      position.brokerResponse = d.raw || brokerResult.raw || d;
      position.executedQty = d.executedQty || qty;
      await position.save({ session });

    } else {
      // PAPER mode: simulate immediate fill at provided price (or market price if provided)
      position.status = "OPEN";
      position.entryPrice = price || position.entryPrice || 0;
      position.currentPrice = position.entryPrice;
      position.brokerResponse = { simulated: true, note: "Paper trading mode - simulated fill" };
      position.executedQty = qty;
      await position.save({ session });
    }

    // Persist idempotency response (in memory for now)
    const responsePayload = {
      positionId: position._id,
      status: position.status,
      entryPrice: position.entryPrice,
      executedQty: position.executedQty || qty,
      brokerOrderId: position.brokerOrderId || null,
      brokerRaw: position.brokerResponse || null
    };
    if (idemKey) {
      IDEMPOTENCY_MAP.set(idemKey, responsePayload);
      // TODO: add TTL eviction in production or use Redis with expiry
    }

    await session.commitTransaction();
    session.endSession();

    return res.status(201).json({ ok:true, msg: "Operación abierta", data: responsePayload });

  } catch (err) {
    // On unexpected error, attempt to rollback changes and free reserved margin
    try {
      await session.abortTransaction();
      session.endSession();
    } catch (ee) { /* ignore */ }

    console.error("openTrade error:", err);
    return res.status(500).json({ ok:false, msg: "Error abriendo trade", error: err.message || String(err) });
  }
};
