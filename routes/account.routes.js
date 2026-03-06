// routes/account.routes.js

import express from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import {
  getAccount,
  updateAccount,
  getAccountBalance
} from "../controllers/account.controller.js";

const router = express.Router();

/*
===========================
 HEALTH CHECK
===========================
*/
router.get("/ping", (req, res) => {
  res.json({
    ok: true,
    route: "account",
    status: "working"
  });
});

/*
===========================
 GET ACCOUNT INFO
===========================
*/
router.get(
  "/profile",
  authMiddleware,
  async (req, res, next) => {
    try {
      await getAccount(req, res);
    } catch (err) {
      next(err);
    }
  }
);

/*
===========================
 UPDATE ACCOUNT
===========================
*/
router.put(
  "/update",
  authMiddleware,
  async (req, res, next) => {
    try {
      await updateAccount(req, res);
    } catch (err) {
      next(err);
    }
  }
);

/*
===========================
 GET BALANCE
===========================
*/
router.get(
  "/balance",
  authMiddleware,
  async (req, res, next) => {
    try {
      await getAccountBalance(req, res);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
