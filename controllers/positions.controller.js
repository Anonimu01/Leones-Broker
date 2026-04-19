import Position from "../models/position.model.js";
import Wallet from "../models/wallet.model.js";

/**
 * GET /positions
 */
export const getPositions = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ ok: false, msg: "Usuario no autenticado" });
    }

    const positions = await Position.find({
      user: userId,
      status: "OPEN"
    }).lean();

    return res.json({
      ok: true,
      data: positions
    });

  } catch (err) {
    console.error("getPositions error:", err);
    return res.status(500).json({
      ok: false,
      msg: "Error obteniendo posiciones"
    });
  }
};


/**
 * POST /positions/close
 */
export const closePosition = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    const { id, currentPrice } = req.body;

    if (!userId) {
      return res.status(401).json({ ok: false, msg: "Usuario no autenticado" });
    }

    if (!id) {
      return res.status(400).json({ ok: false, msg: "Id requerido" });
    }

    const pos = await Position.findOne({
      _id: id,
      user: userId,
      status: "OPEN"
    });

    if (!pos) {
      return res.status(404).json({ ok: false, msg: "Posición no encontrada" });
    }

    const priceNow = Number(currentPrice ?? pos.currentPrice ?? pos.entryPrice ?? 0);
    const entry = Number(pos.entryPrice || 0);
    const qty = Number(pos.qty || 0);

    const sign = (pos.side === "SHORT" || pos.side === "SELL") ? -1 : 1;

    const realized = (priceNow - entry) * qty * sign;

    const wallet = await Wallet.findOne({ user: userId });

    if (wallet) {
      // liberar margen
      wallet.marginUsed = Math.max(0, (wallet.marginUsed || 0) - (pos.marginReserved || 0));

      // aplicar ganancia o pérdida
      wallet.balanceOwn = (wallet.balanceOwn || 0) + realized;

      await wallet.save();
    }

    pos.status = "CLOSED";
    pos.realizedPnl = realized;
    pos.currentPrice = priceNow;
    pos.closedAt = new Date();

    await pos.save();

    return res.json({
      ok: true,
      msg: "Posición cerrada",
      data: {
        realizedPnl: realized,
        newBalance: wallet ? wallet.balanceOwn : null
      }
    });

  } catch (err) {
    console.error("closePosition error:", err);
    return res.status(500).json({
      ok: false,
      msg: "Error cerrando posición"
    });
  }
};


/**
 * POST /positions/close-all
 */
export const closeAllPositions = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;

    if (!userId) {
      return res.status(401).json({ ok: false, msg: "Usuario no autenticado" });
    }

    const openPositions = await Position.find({
      user: userId,
      status: "OPEN"
    });

    if (!openPositions.length) {
      return res.json({
        ok: true,
        msg: "No hay posiciones abiertas",
        data: { closed: 0 }
      });
    }

    const wallet = await Wallet.findOne({ user: userId });

    let totalRealized = 0;

    for (const pos of openPositions) {
      const priceNow = Number(pos.currentPrice ?? pos.entryPrice ?? 0);
      const entry = Number(pos.entryPrice || 0);
      const qty = Number(pos.qty || 0);

      const sign = (pos.side === "SHORT" || pos.side === "SELL") ? -1 : 1;

      const realized = (priceNow - entry) * qty * sign;

      if (wallet) {
        wallet.marginUsed = Math.max(0, (wallet.marginUsed || 0) - (pos.marginReserved || 0));
        wallet.balanceOwn = (wallet.balanceOwn || 0) + realized;
      }

      pos.status = "CLOSED";
      pos.realizedPnl = realized;
      pos.closedAt = new Date();

      await pos.save();

      totalRealized += realized;
    }

    if (wallet) await wallet.save();

    return res.json({
      ok: true,
      msg: "Posiciones cerradas",
      data: {
        closed: openPositions.length,
        totalRealized,
        newBalance: wallet ? wallet.balanceOwn : null
      }
    });

  } catch (err) {
    console.error("closeAllPositions error:", err);
    return res.status(500).json({
      ok: false,
      msg: "Error cerrando posiciones"
    });
  }
};
