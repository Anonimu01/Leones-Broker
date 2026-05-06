import express from "express";
import { getPrice } from "../services/market.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    let symbol = req.query.symbol;

    if (!symbol) {
      return res.status(400).json({
        ok: false,
        error: "Symbol requerido"
      });
    }

    // 🔥 FIX CRÍTICO: normalización del símbolo
    symbol = symbol
      .replace("OANDA:", "")
      .replace("/", "")
      .toUpperCase();

    const data = await getPrice(symbol);

    if (!data || !data.price) {
      return res.status(404).json({
        ok: false,
        error: "Precio no disponible"
      });
    }

    return res.json({
      ok: true,
      symbol: data.symbol,
      price: data.price
    });

  } catch (err) {
    console.error("❌ PRICE ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "Error interno"
    });
  }
});

export default router;
