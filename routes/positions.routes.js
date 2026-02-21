import express from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import { getPositions, closePosition, closeAllPositions } from "../controllers/positions.controller.js";

const router = express.Router();

router.get("/", authMiddleware, getPositions);
router.post("/close", authMiddleware, closePosition);
router.post("/close-all", authMiddleware, closeAllPositions);

export default router;
