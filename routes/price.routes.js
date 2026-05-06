import express from "express";
import { getPrice } from "../services/market.js";

const router = express.Router();

function normalizeSymbol(symbol) {
  return String(symbol)
    .toUpperCase()
    // elimina TODO lo relacionado a OANDA sin importar posición
    .replace(/OANDA:?/g, "")
    // elimina barras
    .replace(/\//g, "")
    // limpia espacios
    .replace(/\s+/g, "")
    .trim();
}

router.get("/", async (req, res) => {
  try {
    let symbol = req.query.symbol;

    if (!symbol) {
      return res.status(400).json({
        ok: false,
        error: "Symbol requerido"
      });
    }

    symbol = normalizeSymbol(symbol);

    console.log("📊 Symbol FINAL normalizado:", symbol);

    const data = await getPrice(symbol);

    if (!data || !data.price || isNaN(data.price)) {
      return res.status(404).json({
        ok: false,
        error: "Precio no disponible",
        symbol
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
