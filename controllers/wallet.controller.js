import Wallet from "../models/wallet.model.js";
import User from "../models/user.model.js";
import Position from "../models/position.model.js";

/**
 * Helper: calcula pnl flotante sumando posiciones abiertas (usa currentPrice si existe)
 */
const computeUnrealizedFromPositions = (positions = []) => {
  let unreal = 0;
  for (const p of positions) {
    const priceNow = Number(p.currentPrice ?? p.entryPrice ?? 0);
    const entry = Number(p.entryPrice || 0);
    const qty = Number(p.qty || 0);
    const sign = (p.side === "SHORT" || p.side === "SELL") ? -1 : 1;
    unreal += (priceNow - entry) * qty * sign;
  }
  return unreal;
};

export const getMyWallet = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    if (!userId) return res.status(401).json({ msg: "Usuario no autenticado" });

    // obtener o crear wallet
    let wallet = await Wallet.findOne({ user: userId });
    const user = await User.findById(userId);

    if (!wallet) {
      wallet = await Wallet.create({
        user: userId,
        balanceOwn: user?.balance ?? 0,
        credit: 0,
        marginUsed: 0,
        leverageFactor: 1
      });
    }

    // traer posiciones abiertas para calcular pnl si es necesario
    const positions = await Position.find({ user: userId, status: "OPEN" }).lean();
    const unreal = computeUnrealizedFromPositions(positions);

    const equity = (wallet.balanceOwn || 0) + (wallet.credit || 0) + unreal;
    const marginLevel = wallet.marginUsed > 0 ? (equity / wallet.marginUsed) * 100 : Infinity;

    return res.json({
      balanceOwn: wallet.balanceOwn,
      credit: wallet.credit,
      marginUsed: wallet.marginUsed,
      leverageFactor: wallet.leverageFactor,
      pnl: unreal,
      equity,
      marginLevel,
      positions // para que frontend muestre detalles
    });
  } catch (err) {
    console.error("getMyWallet error:", err);
    return res.status(500).json({ msg: "Error obteniendo wallet" });
  }
};

/**
 * POST /wallet/revoke-leverage
 * Quita el crédito/apalancamiento al usuario (se puede llamar desde admin o automáticamente)
 */
export const revokeLeverage = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?._id;
    if (!userId) return res.status(401).json({ msg: "Usuario no autenticado" });

    let wallet = await Wallet.findOne({ user: userId });
    if (!wallet) return res.status(404).json({ msg: "Wallet no encontrada" });

    wallet.credit = 0;
    await wallet.save();

    return res.json({ msg: "Apalancamiento revocado", credit: wallet.credit });
  } catch (err) {
    console.error("revokeLeverage error:", err);
    return res.status(500).json({ msg: "Error revocando apalancamiento" });
  }
};
