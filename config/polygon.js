// config/polygon.js
// Lee la clave desde .env: POLYGON_API_KEY o POLYGON_KEY

export const key =
  process.env.POLYGON_API_KEY ||
  process.env.POLYGON_KEY ||
  "";

/*
Endpoints por clase de activo
*/
export const endpoints = {
  stocks: "wss://socket.polygon.io/stocks",
  crypto: "wss://socket.polygon.io/crypto",
  forex: "wss://socket.polygon.io/forex"
  // puedes agregar más según tu plan
};

/*
Prefijos de suscripción
*/
export const prefixes = {
  trades: "T.",   // ejemplo: T.AAPL
  quotes: "Q.",   // ejemplo: Q.AAPL
  aggs: "A."      // agregados
};
