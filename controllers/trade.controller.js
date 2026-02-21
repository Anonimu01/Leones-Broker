import Position from "../models/position.model.js";
import Wallet from "../models/wallet.model.js";

/**
 * POST /trade/open
 * body: { symbol, qty, price, side, type }
 */
export const openTrade = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    if (!userId) return res.status(401).json({ msg: "Usuario no autenticado" });

    let { symbol, qty, price, side } = req.body;
    qty = Number(qty || 0);
    price = Number(price || 0);
    side = (side || "BUY").toString().toUpperCase();

    if (!symbol || !qty || !price) return res.status(400).json({ msg: "symbol, qty y price son obligatorios" });

    // obtener wallet
    let wallet = await Wallet.findOne({ user: userId });
    if (!wallet) {
      wallet = await Wallet.create({ user: userId, balanceOwn: 0, credit: 0, marginUsed: 0, leverageFactor: 1 });
    }

    const leverage = Number(wallet.leverageFactor || 1);
    const notional = Math.abs(qty * price);

    // required margin: notional / leverage
    const requiredMargin = notional / Math.max(1, leverage);

    const freeMargin = (wallet.balanceOwn || 0) + (wallet.credit || 0) - (wallet.marginUsed || 0);

    if (freeMargin < requiredMargin) {
      return res.status(400).json({ msg: "Fondos insuficientes para abrir la operación", freeMargin, requiredMargin });
    }

    // crear posición y reservar margen
    const pos = await Position.create({
      user: userId,
      symbol,
      side: (side === "SELL" || side === "SHORT") ? "SHORT" : "LONG",
      qty,
      entryPrice: price,
      currentPrice: price,
      marginReserved: requiredMargin,
      status: "OPEN"
    });

    wallet.marginUsed = (wallet.marginUsed || 0) + requiredMargin;
    await wallet.save();

    // devolver positions actualizadas
    const positions = await Position.find({ user: userId, status: "OPEN" });

    return res.status(201).json({ msg: "Operación abierta", position: pos, positions });
  } catch (err) {
    console.error("openTrade error:", err);
    return res.status(500).json({ msg: "Error abriendo trade" });
  }
};
