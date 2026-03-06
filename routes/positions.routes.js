// routes/positions.routes.js

import express from "express";
import authMiddleware from "../middlewares/auth.middleware.js";
import {
  getPositions,
  closePosition,
  closeAllPositions
} from "../controllers/positions.controller.js";

const router = express.Router();

/*
============================
 HEALTH CHECK
============================
*/
router.get("/ping", (req, res) => {
  res.json({
    ok: true,
    route: "positions",
    status: "working"
  });
});

/*
============================
 GET POSITIONS
============================
*/
router.get(
  "/",
  authMiddleware,
  async (req, res, next) => {
    try {

      await getPositions(req, res);

    } catch (err) {

      console.error("POSITIONS GET ERROR:", err);
      next(err);

    }
  }
);

/*
============================
 CLOSE POSITION
============================
*/
router.post(
  "/close",
  authMiddleware,
  async (req, res, next) => {
    try {

      await closePosition(req, res);

    } catch (err) {

      console.error("CLOSE POSITION ERROR:", err);
      next(err);

    }
  }
);

/*
============================
 CLOSE ALL POSITIONS
============================
*/
router.post(
  "/close-all",
  authMiddleware,
  async (req, res, next) => {
    try {

      await closeAllPositions(req, res);

    } catch (err) {

      console.error("CLOSE ALL POSITIONS ERROR:", err);
      next(err);

    }
  }
);

export default router;
