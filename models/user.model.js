// models/user.model.js
import mongoose from "mongoose";

const addressSchema = new mongoose.Schema({
  street: { type: String, trim: true },
  city: { type: String, trim: true },
  state: { type: String, trim: true },
  zip: { type: String, trim: true },
  country: { type: String, trim: true }
}, { _id: false });

const documentSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  url: { type: String, trim: true },
  type: { type: String, trim: true }, // ej: "dni", "pasaporte", "foto"
  uploadedAt: { type: Date, default: Date.now }
}, { _id: false });

const userSchema = new mongoose.Schema({
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

  phone: {
    type: String,
    trim: true,
    default: ""
  },

  password: {
    type: String,
    required: true
  },

  address: addressSchema,

  documents: {
    type: [documentSchema],
    default: []
  },

  roles: {
    type: [String],
    default: ["user"]
  },

  balance: {
    type: Number,
    default: 0
  },

  verified: {
    type: Boolean,
    default: false
  },

  verificationToken: {
    type: String,
    default: null
  }

}, { timestamps: true });

// Índice único por email
userSchema.index({ email: 1 }, { unique: true });

// Evitar devolver datos sensibles por accidente
userSchema.set("toJSON", {
  transform: (doc, ret) => {
    delete ret.password;
    delete ret.verificationToken;
    delete ret.__v;
    return ret;
  }
});

export default mongoose.model("User", userSchema);
