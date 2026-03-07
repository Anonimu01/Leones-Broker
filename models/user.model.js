import mongoose from "mongoose";

const documentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  url: {
    type: String,
    required: true
  },
  uploadedAt: {
    type: Date,
    default: Date.now
  }
});

// Main user schema
const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },

    // keep 'password' as the stored hashed password
    password: {
      type: String,
      required: true
    },

    // optional fields
    phone: {
      type: String,
      trim: true,
      default: ""
    },

    address: {
      type: String,
      trim: true,
      default: ""
    },

    documents: [documentSchema],

    balance: {
      type: Number,
      default: 0
    },

    verified: {
      type: Boolean,
      default: false
    },

    // verifyToken is the canonical field used by the controller.
    // Provide an alias 'verificationToken' so both names work.
    verifyToken: {
      type: String,
      default: null,
      alias: "verificationToken"
    },

    // expiration date for the verification token
    verifyExpires: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

// Optional: create an index for token lookups (speeds verification queries)
userSchema.index({ verifyToken: 1 }, { sparse: true });

export default mongoose.model("User", userSchema);
