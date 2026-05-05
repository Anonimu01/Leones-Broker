import mongoose from "mongoose";

function normalizeSide(value) {
  const side = String(value || "").toUpperCase().trim();

  switch (side) {
    case "LONG":
    case "BUY":
      return "BUY";
    case "SHORT":
    case "SELL":
      return "SELL";
    default:
      return "BUY";
  }
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

    status: {
      type: String,
      enum: ["OPEN", "CLOSED"],
      default: "OPEN",
      index: true,
    },

    pnl: {
      type: Number,
      default: 0,
    },

    profit: {
      type: Number,
      default: 0,
    },

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

//
// 🔥 VALIDACIÓN ANTES DE GUARDAR (EVITA NaN + CRASHES)
//
PositionSchema.pre("validate", function (next) {
  if (!Number.isFinite(this.qty)) {
    this.invalidate("qty", "Qty inválido");
  }

  if (!Number.isFinite(this.entryPrice)) {
    this.invalidate("entryPrice", "EntryPrice inválido");
  }

  if (this.currentPrice != null && !Number.isFinite(this.currentPrice)) {
    this.invalidate("currentPrice", "CurrentPrice inválido");
  }

  if (this.closePrice != null && !Number.isFinite(this.closePrice)) {
    this.invalidate("closePrice", "ClosePrice inválido");
  }

  next();
});

//
// 🔥 NORMALIZACIÓN FINAL SEGURA
//
PositionSchema.pre("save", function (next) {
  if (this.side) {
    this.side = normalizeSide(this.side);
  }

  // Evitar NaN en producción (esto era causa silenciosa de bugs)
  if (!Number.isFinite(this.pnl)) this.pnl = 0;
  if (!Number.isFinite(this.profit)) this.profit = this.pnl;
  if (!Number.isFinite(this.realizedPnl)) this.realizedPnl = 0;

  // Seguridad extra para margen
  if (!Number.isFinite(this.marginReserved)) this.marginReserved = 0;

  next();
});

PositionSchema.index({ user: 1, status: 1 });
PositionSchema.index({ user: 1, symbol: 1, status: 1 });

export default mongoose.model("Position", PositionSchema);
