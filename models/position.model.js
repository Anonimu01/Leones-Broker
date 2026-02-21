import mongoose from "mongoose";

const PositionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

  symbol: { type: String, required: true },
  side: { type: String, enum: ["LONG", "SHORT", "BUY", "SELL"], required: true },
  qty: { type: Number, required: true },
  entryPrice: { type: Number, required: true },
  currentPrice: { type: Number, default: null },

  // margen reservado para esta posición (calculated at open)
  marginReserved: { type: Number, default: 0 },

  // estado: OPEN / CLOSED
  status: { type: String, enum: ["OPEN", "CLOSED"], default: "OPEN" },

  // PnL realizado al cerrar
  realizedPnl: { type: Number, default: 0 },

  // timestamps closedAt, createdAt, updatedAt
  closedAt: { type: Date, default: null }
}, { timestamps: true });

export default mongoose.model("Position", PositionSchema);
