import express from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import { openTrade } from "../controllers/trade.controller.js";

const router = express.Router();

router.post("/open", authMiddleware, openTrade);

export default router;
