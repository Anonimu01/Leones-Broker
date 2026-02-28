  // añade en la clase PolygonSocket

  _formatForPolygon(symbol, cls) {
    // Recibe: "BINANCE:BTCUSDT", "EUR/USD", "I:SPX", "AAPL"
    if (!symbol) return symbol;
    let s = String(symbol).trim();

    // Si viene con exchange prefix "EXCHANGE:SYMBOL" -> quitar la parte del exchange
    if (s.includes(":") && !s.startsWith("I:") && !s.startsWith("O:")) {
      // mantiene símbolos tipo "I:SPX" (indices) y "O:..." (opciones)
      s = s.split(":").pop();
    }

    // Forex: Polygon suele usar sin slash
    if (cls === "forex") {
      s = s.replace("/", "").replace("_", "");
    }

    // Crypto: unifica separadores, quita "-" o "/"
    if (cls === "crypto") {
      s = s.replace("/", "").replace("-", "");
      // Opcional: transformar BINANCE pair BTCUSDT -> BTCUSD (algunos feeds usan USD no USDT)
      // No lo forcemos por defecto — mejor dejar como venga.
    }

    // Stocks / others: limpiar espacios
    s = s.replace(/\s+/g, "");

    return s;
  }

  _normalizeSubscribeStr(symbol, kind = "trades") {
    const pref = this.prefixes[
      kind === "quotes" ? "quotes" : kind === "aggs" ? "aggs" : "trades"
    ] || "";

    // adivina clase para normalizar si es necesario
    const cls = this._guessClass(symbol);
    const formatted = this._formatForPolygon(symbol, cls);

    return `${pref}${String(formatted).trim()}`;
  }
