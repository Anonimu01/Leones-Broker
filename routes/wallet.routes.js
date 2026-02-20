import express from "express";
import { getMyWallet } from "../controllers/wallet.controller.js";
import authMiddleware from "../middlewares/auth.middleware.js";

const router = express.Router();

router.get("/me", authMiddleware, getMyWallet);

export default router;
