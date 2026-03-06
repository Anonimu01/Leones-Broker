// routes/auth.routes.js

import express from "express";

import {
  registerUser,
  loginUser,
  resendVerificationUser,
  verifyUser
} from "../controllers/auth.controller.js";

const router = express.Router();

/*
============================
 HEALTH CHECK
============================
*/
router.get("/ping", (req, res) => {
  res.json({
    ok: true,
    route: "auth",
    status: "working"
  });
});

/*
============================
 VALIDATORS
============================
*/

const validateRegister = (req, res, next) => {

  const { name, email, password, address, phone } = req.body || {};

  if (!name || !email || !password || !address || !phone) {
    return res.status(400).json({
      ok: false,
      message: "Missing fields",
      required: ["name", "email", "password", "address", "phone"]
    });
  }

  if (password.length < 6) {
    return res.status(400).json({
      ok: false,
      message: "Password must be at least 6 characters"
    });
  }

  next();
};

const validateLogin = (req, res, next) => {

  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({
      ok: false,
      message: "Email and password required"
    });
  }

  next();
};

const validateEmail = (req, res, next) => {

  const { email } = req.body || {};

  if (!email) {
    return res.status(400).json({
      ok: false,
      message: "Email required"
    });
  }

  next();
};

/*
============================
 REGISTER
============================
*/
router.post(
  "/register",
  validateRegister,
  async (req, res, next) => {
    try {

      await registerUser(req, res);

    } catch (err) {

      console.error("AUTH REGISTER ROUTE ERROR:", err);
      next(err);

    }
  }
);

/*
============================
 LOGIN
============================
*/
router.post(
  "/login",
  validateLogin,
  async (req, res, next) => {
    try {

      await loginUser(req, res);

    } catch (err) {

      console.error("AUTH LOGIN ROUTE ERROR:", err);
      next(err);

    }
  }
);

/*
============================
 VERIFY EMAIL
============================
*/
router.get(
  "/verify",
  async (req, res, next) => {
    try {

      await verifyUser(req, res);

    } catch (err) {

      console.error("AUTH VERIFY ROUTE ERROR:", err);
      next(err);

    }
  }
);

/*
============================
 RESEND VERIFICATION
============================
*/
router.post(
  "/resend-verification",
  validateEmail,
  async (req, res, next) => {
    try {

      await resendVerificationUser(req, res);

    } catch (err) {

      console.error("AUTH RESEND ROUTE ERROR:", err);
      next(err);

    }
  }
);

export default router;
