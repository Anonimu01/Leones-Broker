import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

const router = express.Router();

// ======================================================
// STORAGE
// ======================================================

const uploadDir = path.join(process.cwd(), "uploads", "withdraws");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const unique =
      Date.now() + "-" + Math.round(Math.random() * 1e9);

    cb(
      null,
      unique + path.extname(file.originalname)
    );
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

// ======================================================
// MODEL
// ======================================================

const withdrawSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    amount: Number,

    account: String,

    bankName: String,

    accountType: String,

    country: String,

    notes: String,

    proofUrl: String,

    status: {
      type: String,
      default: "pending",
    },
  },
  {
    timestamps: true,
  }
);

const Withdraw =
  mongoose.models.Withdraw ||
  mongoose.model("Withdraw", withdrawSchema);

// ======================================================
// AUTH
// ======================================================

function getUserFromToken(req) {
  try {
    const auth = req.headers.authorization || "";

    if (!auth.startsWith("Bearer ")) return null;

    const token = auth.split(" ")[1];

    return jwt.verify(
      token,
      process.env.JWT_SECRET
    );
  } catch (e) {
    return null;
  }
}

// ======================================================
// CREATE WITHDRAW
// ======================================================

router.post(
  "/",
  upload.single("proof"),
  async (req, res) => {
    try {
      const user = getUserFromToken(req);

      if (!user) {
        return res.status(401).json({
          ok: false,
          error: "Unauthorized",
        });
      }

      const {
        amount,
        account,
        bankName,
        accountType,
        country,
        notes,
      } = req.body;

      const proofUrl = req.file
        ? `/uploads/withdraws/${req.file.filename}`
        : "";

      const withdraw = await Withdraw.create({
        userId: user.id,
        amount,
        account,
        bankName,
        accountType,
        country,
        notes,
        proofUrl,
      });

      res.json({
        ok: true,
        withdraw,
      });
    } catch (err) {
      console.error("WITHDRAW ERROR:", err);

      res.status(500).json({
        ok: false,
        error: err.message,
      });
    }
  }
);

// ======================================================
// GET USER WITHDRAWS
// ======================================================

router.get("/", async (req, res) => {
  try {
    const user = getUserFromToken(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
      });
    }

    const withdraws = await Withdraw.find({
      userId: user.id,
    }).sort({ createdAt: -1 });

    res.json({
      ok: true,
      withdraws,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

export default router;
