import mongoose from "mongoose";

const WalletSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },

  // saldo disponible (retirable) colocado por admin o por sistema
  balanceOwn: { type: Number, default: 0 },

  // crédito / apalancamiento otorgado por admin (no disponible para retiro)
  credit: { type: Number, default: 0 },

  // margen usado por posiciones abiertas
  marginUsed: { type: Number, default: 0 },

  // factor de apalancamiento (por ejemplo 10 -> 10x)
  leverageFactor: { type: Number, default: 1 },

  // campos opcionales para reporting
  pnl: { type: Number, default: 0 },
  equityReported: { type: Number, default: 0 }
}, { timestamps: true });

// virtuals for convenience
WalletSchema.virtual("freeMargin").get(function () {
  // freeMargin = equity - marginUsed, where equity = balanceOwn + credit + pnl
  const equity = (this.balanceOwn || 0) + (this.credit || 0) + (this.pnl || 0);
  return equity - (this.marginUsed || 0);
});

export default mongoose.model("Wallet", WalletSchema);
