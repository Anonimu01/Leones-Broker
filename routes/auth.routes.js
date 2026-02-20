// routes/auth.routes.js
import express from "express";
import {
  registerUser,
  loginUser,
  resendVerification
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
  const { name, email, password, address, phone } = req.body;

  if (!name || !email || !password || !address || !phone) {
    return res.status(400).json({
      error: "Missing fields",
      required: ["name", "email", "password", "address", "phone"]
    });
  }

  if (password.length < 6)
    return res.status(400).json({ error: "Password must be at least 6 chars" });

  next();
};

const validateLogin = (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res.status(400).json({ error: "Email and password required" });

  next();
};

const validateEmail = (req, res, next) => {
  if (!req.body?.email)
    return res.status(400).json({ error: "Email required" });

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
      await resendVerification(req, res);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
