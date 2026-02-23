// config/polygon.js
// Lee la clave desde .env: POLYGON_API_KEY
const POLYGON_KEY = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY || '';

module.exports = {
  key: POLYGON_KEY,
  // endpoints por clase de activo
  endpoints: {
    stocks: 'wss://socket.polygon.io/stocks',
    crypto: 'wss://socket.polygon.io/crypto',
    forex: 'wss://socket.polygon.io/forex',
    // agregar más si necesitas (options, indices) según plan
  },
  // prefijos de suscripción (usaremos T=trades, Q=quotes, A=aggregates)
  prefixes: {
    trades: 'T.',    // ejemplo: T.AAPL
    quotes: 'Q.',    // ejemplo: Q.AAPL
    aggs: 'A.'       // agregados (1s, 1m, etc) según disponibilidad
  }
};
