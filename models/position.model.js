import mongoose from "mongoose";

function normalizeSide(value) {
  const side = String(value || "").toUpperCase().trim();

  if (side === "LONG") return "BUY";
  if (side === "SHORT") return "SELL";
  if (side === "SELL") return "SELL";
  return "BUY";
}

const PositionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    symbol: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      index: true,
    },

    side: {
      type: String,
      enum: ["BUY", "SELL", "LONG", "SHORT"],
      required: true,
      set: normalizeSide,
    },

    type: {
      type: String,
      default: "MARKET",
      trim: true,
      uppercase: true,
    },

    qty: {
      type: Number,
      required: true,
      min: 0,
    },

    entryPrice: {
      type: Number,
      required: true,
      min: 0,
    },

    currentPrice: {
      type: Number,
      default: null,
      min: 0,
    },

    closePrice: {
      type: Number,
      default: null,
      min: 0,
    },

    // margen reservado para esta posición
    marginReserved: {
      type: Number,
      default: 0,
      min: 0,
    },

    leverage: {
      type: Number,
      default: 1,
      min: 1,
    },

    // estado: OPEN / CLOSED
    status: {
      type: String,
      enum: ["OPEN", "CLOSED"],
      default: "OPEN",
      index: true,
    },

    // PnL flotante / actualizado en tiempo real
    pnl: {
      type: Number,
      default: 0,
    },

    // utilidad extra por compatibilidad con tu código
    profit: {
      type: Number,
      default: 0,
    },

    // PnL realizado al cerrar
    realizedPnl: {
      type: Number,
      default: 0,
    },

    closedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Mantener consistencia entre campos que tu backend ya usa
PositionSchema.pre("save", function (next) {
  if (this.side) {
    this.side = normalizeSide(this.side);
  }

  if (this.pnl == null) this.pnl = 0;
  if (this.profit == null) this.profit = this.pnl;
  if (this.realizedPnl == null) this.realizedPnl = 0;

  next();
});

PositionSchema.index({ user: 1, status: 1 });
PositionSchema.index({ user: 1, symbol: 1, status: 1 });

export default mongoose.model("Position", PositionSchema);
