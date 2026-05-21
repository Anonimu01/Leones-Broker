// models/withdraw.model.js
import mongoose from "mongoose";

const withdrawSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: "USD" },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    method: { type: String, default: "bank" },
    note: { type: String, default: "" },
    processedAt: { type: Date },
    rejectedAt: { type: Date },
    rejectReason: { type: String, default: "" },
  },
  { timestamps: true }
);

const Withdraw = mongoose.models.Withdraw || mongoose.model("Withdraw", withdrawSchema);
export default Withdraw;
