// utils/symbol.js

export function normalizeSymbol(symbol) {
  if (!symbol) return "";

  return String(symbol)
    .toUpperCase()
    // elimina prefijo OANDA en cualquier forma
    .replace(/OANDA:?/g, "")
    // elimina barras EUR/USD → EURUSD
    .replace(/\//g, "")
    // elimina espacios
    .replace(/\s+/g, "")
    .trim()
    // convierte EURUSD → EUR_USD (FORMATO FINAL)
    .replace(/([A-Z]{3})([A-Z]{3})/, "$1_$2");
}
