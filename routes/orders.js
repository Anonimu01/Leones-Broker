import express from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import {
  createOrder,
  getUserOrders,
  getOrderById,
  cancelOrder
} from "../controllers/trade.controller.js";

const router = express.Router();

/*
|--------------------------------------------------------------------------
| ORDERS ROUTES — REAL TRADING READY
|--------------------------------------------------------------------------
| Todas protegidas con authMiddleware
| Usuario debe estar autenticado
|
| Base URL:
| /api/orders
|
*/

/**
 * Crear orden (Market / Limit / Stop)
 * POST /api/orders
 */
router.post("/", authMiddleware, async (req, res, next) => {
  try {
    await createOrder(req, res);
  } catch (err) {
    next(err);
  }
});

/**
 * Obtener todas las órdenes del usuario
 * GET /api/orders
 */
router.get("/", authMiddleware, async (req, res, next) => {
  try {
    await getUserOrders(req, res);
  } catch (err) {
    next(err);
  }
});

/**
 * Obtener una orden específica
 * GET /api/orders/:id
 */
router.get("/:id", authMiddleware, async (req, res, next) => {
  try {
    await getOrderById(req, res);
  } catch (err) {
    next(err);
  }
});

/**
 * Cancelar orden abierta
 * DELETE /api/orders/:id
 */
router.delete("/:id", authMiddleware, async (req, res, next) => {
  try {
    await cancelOrder(req, res);
  } catch (err) {
    next(err);
  }
});

export default router;
