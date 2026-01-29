import mongoose from "mongoose";

const verificationSchema = new mongoose.Schema(
  {
    userId: mongoose.Schema.Types.ObjectId,
    documentUrl: String,
    addressProofUrl: String,
    status: { type: String, default: "pending" }
  },
  { timestamps: true }
);

export default mongoose.model("Verification", verificationSchema);
