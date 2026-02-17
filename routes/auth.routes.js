import express from "express";
import { registerUser, loginUser } from "../controllers/auth.controller.js";

const router = express.Router();

// ============================
// REGISTRO
// ============================
router.post("/register", registerUser);


// ============================
// LOGIN
// ============================
router.post("/login", loginUser);


export default router;
