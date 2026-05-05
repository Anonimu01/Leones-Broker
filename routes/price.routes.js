import express from "express";
import { getPrice } from "../services/market.service.js";

const router = express.Router();

/* =========================
   📊 PRECIO DE MERCADO
   GET /api/price?symbol=
========================= */
router.get("/", async (req, res) => {
  try {
    const symbol = req.query.symbol;

    if (!symbol) {
      return res.status(400).json({
        ok: false,
        error: "Symbol requerido"
      });
    }

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
      price: data.price,
      source: data.source
    });

  } catch (err) {
    console.error("❌ PRICE ROUTE ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: "Error interno del servidor"
    });
  }
});

export default router;
