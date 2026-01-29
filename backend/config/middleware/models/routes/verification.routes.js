import express from "express";
import multer from "multer";
import Verification from "../models/Verification.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();

/* ===============================
   CONFIG SUBIDA
================================ */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "public/uploads");
  },
  filename: (req, file, cb) => {
    const ext = file.originalname.split(".").pop();
    cb(null, Date.now() + "." + ext);
  }
});

const upload = multer({ storage });

/* ===============================
   ENVIAR DOCUMENTOS KYC
================================ */
router.post(
  "/",
  auth(),
  upload.fields([
    { name: "document", maxCount: 1 },
    { name: "address", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      await Verification.create({
        userId: req.user.id,
        documentUrl: req.files.document?.[0]?.filename,
        addressProofUrl: req.files.address?.[0]?.filename,
        status: "pending"
      });

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ msg: "Error al enviar verificación" });
    }
  }
);

/* ===============================
   ADMIN VER KYC
================================ */
router.get("/all", auth("admin"), async (req, res) => {
  const data = await Verification.find().populate("userId");
  res.json(data);
});

/* ===============================
   ADMIN APROBAR / RECHAZAR
================================ */
router.post("/update", auth("admin"), async (req, res) => {
  const { id, status } = req.body;

  await Verification.findByIdAndUpdate(id, { status });

  res.json({ ok: true });
});

export default router;
