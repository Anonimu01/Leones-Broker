import mongoose from "mongoose";

const documentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

// Main user schema
const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    // hashed password
    password: {
      type: String,
      required: true,
    },

    phone: {
      type: String,
      trim: true,
      default: "",
    },

    address: {
      type: String,
      trim: true,
      default: "",
    },

    documents: {
      type: [documentSchema],
      default: [],
    },

    // balance principal usado por tu wallet / trading logic
    balance: {
      type: Number,
      default: 0,
    },

    // crédito extra si tu sistema lo usa
    credit: {
      type: Number,
      default: 0,
    },

    // factor de apalancamiento base si luego lo lees desde el usuario
    leverageFactor: {
      type: Number,
      default: 1,
      min: 1,
    },

    verified: {
      type: Boolean,
      default: false,
    },

    // nombre canónico para el token
    verifyToken: {
      type: String,
      default: null,
      alias: "verificationToken",
      index: true,
    },

    verifyExpires: {
      type: Date,
      default: null,
    },

    // estado general del usuario
    active: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Índices útiles
userSchema.index({ verifyToken: 1 }, { sparse: true });
userSchema.index({ email: 1 });

// Limpieza ligera antes de guardar
userSchema.pre("save", function (next) {
  if (typeof this.email === "string") {
    this.email = this.email.trim().toLowerCase();
  }

  if (typeof this.name === "string") {
    this.name = this.name.trim();
  }

  if (!Number.isFinite(this.balance)) this.balance = 0;
  if (!Number.isFinite(this.credit)) this.credit = 0;
  if (!Number.isFinite(this.leverageFactor) || this.leverageFactor < 1) {
    this.leverageFactor = 1;
  }

  next();
});

export default mongoose.model("User", userSchema);
