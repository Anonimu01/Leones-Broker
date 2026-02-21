// jobs/risk.job.js
/**
 * Risk watcher: revisa periódicamente todas las wallets y:
 * - Si marginLevel <= closeThreshold -> cierra todas las posiciones del usuario
 * - Si marginLevel < alertThreshold -> revoca apalancamiento (credit = 0) y genera log
 *
 * Usage:
 *   import { startRiskWatcher, stopRiskWatcher } from "./jobs/risk.job.js";
 *   startRiskWatcher({ intervalMs: 30_000, alertThreshold: 30, closeThreshold: 15 });
 *
 * Nota: este job opera directamente sobre modelos Position y Wallet.
 */

import Wallet from "../models/wallet.model.js";
import Position from "../models/position.model.js";
import mongoose from "mongoose";

let _intervalId = null;
let _running = false;

export const startRiskWatcher = ({ intervalMs = 30_000, alertThreshold = 30, closeThreshold = 15 } = {}) => {
  if (_running) return;
  _running = true;
  console.log(`[RISK JOB] iniciando watcher. interval=${intervalMs}ms alert=${alertThreshold}% close=${closeThreshold}%`);

  _intervalId = setInterval(async () => {
    try {
      // obtener todas las wallets donde marginUsed > 0 o credit > 0 (más eficientes)
      const wallets = await Wallet.find({ $or: [{ marginUsed: { $gt: 0 } }, { credit: { $gt: 0 } }] }).lean();

      for (const w of wallets) {
        try {
          const wallet = await Wallet.findById(w._id);
          if (!wallet) continue;

          // obtener posiciones abiertas
          const positions = await Position.find({ user: wallet.user, status: "OPEN" }).lean();

          // calcular unreal desde posiciones (usar currentPrice o entryPrice)
          let unreal = 0;
          for (const p of positions) {
            const priceNow = Number(p.currentPrice ?? p.entryPrice ?? 0);
            const entry = Number(p.entryPrice ?? 0);
            const qty = Number(p.qty ?? 0);
            const sign = (p.side === "SHORT" || p.side === "SELL") ? -1 : 1;
            unreal += (priceNow - entry) * qty * sign;
          }

          const equity = (wallet.balanceOwn || 0) + (wallet.credit || 0) + unreal;
          const marginUsed = Number(wallet.marginUsed || 0);
          const marginLevel = marginUsed > 0 ? (equity / marginUsed) * 100 : Infinity;

          // close positions if marginLevel <= closeThreshold
          if (isFinite(marginLevel) && marginLevel <= closeThreshold) {
            console.warn(`[RISK JOB] Usuario ${String(wallet.user)} marginLevel=${marginLevel.toFixed(2)}% <= ${closeThreshold}%. Cerrando posiciones...`);

            // cerrar todas las posiciones (similar a controller closeAllPositions)
            const openPositions = await Position.find({ user: wallet.user, status: "OPEN" });
            let totalRealized = 0;
            for (const pos of openPositions) {
              const priceNow = Number(pos.currentPrice ?? pos.entryPrice ?? 0);
              const entry = Number(pos.entryPrice || 0);
              const qty = Number(pos.qty || 0);
              const sign = (pos.side === "SHORT" || pos.side === "SELL") ? -1 : 1;
              const realized = (priceNow - entry) * qty * sign;
              totalRealized += realized;

              // liberar margin reservado
              wallet.marginUsed = Math.max(0, (wallet.marginUsed || 0) - (pos.marginReserved || 0));
              wallet.balanceOwn = (wallet.balanceOwn || 0) + realized;

              pos.status = "CLOSED";
              pos.realizedPnl = realized;
              pos.closedAt = new Date();
              await pos.save();
            }
            await wallet.save();
            console.log(`[RISK JOB] Cerradas ${openPositions.length} posiciones; realized=${totalRealized}. wallet=${wallet._id}`);
            continue;
          }

          // revoke leverage if marginLevel < alertThreshold and user still has credit
          if (isFinite(marginLevel) && marginLevel < alertThreshold && (wallet.credit || 0) > 0) {
            console.warn(`[RISK JOB] Usuario ${String(wallet.user)} marginLevel=${marginLevel.toFixed(2)}% < ${alertThreshold}%. Revocando apalancamiento.`);
            wallet.credit = 0;
            await wallet.save();
            // optionally you could notify user (email or push) — hook aquí
            continue;
          }

          // else, everything ok for this wallet
        } catch (innerErr) {
          console.error("RISK JOB: error procesando wallet", w._id, innerErr);
        }
      }
    } catch (err) {
      console.error("RISK JOB error:", err);
    }
  }, intervalMs);
};

export const stopRiskWatcher = () => {
  if (_intervalId) clearInterval(_intervalId);
  _intervalId = null;
  _running = false;
  console.log("[RISK JOB] detenido");
};
