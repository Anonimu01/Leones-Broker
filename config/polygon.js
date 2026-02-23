// config/polygon.js
// Lee la clave desde .env: POLYGON_API_KEY o POLYGON_KEY

export const key =
  process.env.POLYGON_API_KEY ||
  process.env.POLYGON_KEY ||
  "";

/*
Endpoints por clase de activo
Ahora incluye TODOS los mercados soportados
*/
export const endpoints = {
  stocks: "wss://socket.polygon.io/stocks",
  crypto: "wss://socket.polygon.io/crypto",
  forex: "wss://socket.polygon.io/forex",

  // añadidos profesionales
  indices: "wss://socket.polygon.io/indices",
  options: "wss://socket.polygon.io/options"
};

/*
Prefijos de suscripción
Compatibles con todos los streams
*/
export const prefixes = {
  trades: "T.",   // trades en vivo
  quotes: "Q.",   // bid/ask
  aggs: "A."      // velas / agregados
};

/*
Helper opcional para listar mercados disponibles
(esto te sirve si quieres mostrarlos en tu overview frontend)
*/
export const availableMarkets = Object.keys(endpoints);
