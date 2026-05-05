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

    balance: {
      type: Number,
      default: 0,
    },

    credit: {
      type: Number,
      default: 0,
    },

    leverageFactor: {
      type: Number,
      default: 1,
      min: 1,
    },

    verified: {
      type: Boolean,
      default: false,
    },

    verifyToken: {
      type: String,
      default: null,
      index: true,
    },

    verifyExpires: {
      type: Date,
      default: null,
    },

    active: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

//
// 🔥 VALIDACIÓN PREVIA (EVITA DATOS SUCIOS)
//
userSchema.pre("validate", function (next) {
  if (this.balance != null && !Number.isFinite(this.balance)) {
    this.invalidate("balance", "Balance inválido");
  }

  if (this.credit != null && !Number.isFinite(this.credit)) {
    this.invalidate("credit", "Credit inválido");
  }

  if (
    this.leverageFactor != null &&
    (!Number.isFinite(this.leverageFactor) || this.leverageFactor < 1)
  ) {
    this.invalidate("leverageFactor", "Leverage inválido");
  }

  next();
});

//
// 🔥 NORMALIZACIÓN SEGURA ANTES DE GUARDAR
//
userSchema.pre("save", function (next) {
  if (typeof this.email === "string") {
    this.email = this.email.trim().toLowerCase();
  }

  if (typeof this.name === "string") {
    this.name = this.name.trim();
  }

  // Evitar NaN silencioso (esto rompe wallets y trading)
  if (!Number.isFinite(this.balance)) this.balance = 0;
  if (!Number.isFinite(this.credit)) this.credit = 0;

  if (!Number.isFinite(this.leverageFactor) || this.leverageFactor < 1) {
    this.leverageFactor = 1;
  }

  next();
});

//
// 🔥 ÍNDICES
//
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ verifyToken: 1 }, { sparse: true });

export default mongoose.model("User", userSchema);
