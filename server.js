import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import { createServer } from "http";
import { Server as IOServer } from "socket.io";

import { connectDB } from "./config/db.js";

import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/user.routes.js";
import verificationRoutes from "./routes/verification.routes.js";
import walletRoutes from "./routes/wallet.routes.js";
import positionsRoutes from "./routes/positions.routes.js";
import tradeRoutes from "./routes/trade.routes.js";

import { startRiskWatcher } from "./jobs/risk.job.js";

import PolygonSocket from "./sockets/polygonSocket.js";
import PriceHandler from "./utils/priceHandler.js";
import marketRoutesFactory from "./routes/market.routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path:
    process.env.NODE_ENV === "production"
      ? undefined
      : path.resolve(__dirname, ".env"),
});

const app = express();
app.set("trust proxy", 1);

connectDB();

/* ---------------- MONGOOSE EVENTS ---------------- */

mongoose.connection.on("connected", () => {
  console.log("✅ MongoDB conectado:", mongoose.connection.name);

  try {
    const intervalMs = Number(process.env.RISK_JOB_INTERVAL_MS) || 30000;
    const alertThreshold = Number(process.env.RISK_ALERT_THRESHOLD) || 30;
    const closeThreshold = Number(process.env.RISK_CLOSE_THRESHOLD) || 15;

    startRiskWatcher({ intervalMs, alertThreshold, closeThreshold });

    console.log(
      `🛡 Risk watcher activo (interval=${intervalMs} alert=${alertThreshold}% close=${closeThreshold}%)`
    );
  } catch (err) {
    console.error("Error iniciando risk watcher:", err);
  }
});

mongoose.connection.on("error", err => {
  console.error("Mongo error:", err);
});

mongoose.connection.on("disconnected", () => {
  console.warn("Mongo desconectado");
});

/* ---------------- MIDDLEWARES ---------------- */

app.use(cors({
  origin: process.env.CLIENT_URL || "*",
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req,res,next)=>{
  console.log(new Date().toISOString(), req.method, req.url);
  next();
});

/* ---------------- HEALTH ---------------- */

app.get("/api/health",(req,res)=>{
  res.json({
    ok:true,
    db:mongoose.connection.name || null,
    polygon: !!process.env.POLYGON_API_KEY
  });
});

/* ---------------- ROUTES ---------------- */

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/verification", verificationRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/positions", positionsRoutes);
app.use("/api/trade", tradeRoutes);

/* ---------------- STATIC ---------------- */

app.use(express.static(path.join(__dirname,"public")));

/* ---------------- SERVER + SOCKET.IO ---------------- */

const server = createServer(app);

const io = new IOServer(server,{
  cors:{
    origin:"*",
    methods:["GET","POST"]
  }
});

/* ---------------- POLYGON REALTIME ---------------- */

const polygonSocket = new PolygonSocket(io);
polygonSocket.connect();

const priceHandler = new PriceHandler(io);

/* ---------------- MARKET ROUTES ---------------- */

try{
  if(typeof marketRoutesFactory === "function"){
    app.use("/api/market", marketRoutesFactory({ polygonSocket }));
  }else{
    app.use("/api/market", marketRoutesFactory);
  }
}catch(err){
  console.warn("market routes error:", err.message);
}

/* ---------------- SOCKET EVENTS ---------------- */

io.on("connection", socket=>{
  console.log("cliente conectado:", socket.id);

  socket.emit("prices_snapshot", priceHandler.prices || {});

  socket.on("subscribe", ({symbol})=>{
    if(!symbol) return;
    polygonSocket.subscribe(symbol);
    socket.join(symbol);
  });

  socket.on("unsubscribe", ({symbol})=>{
    if(!symbol) return;
    polygonSocket.unsubscribe(symbol);
    socket.leave(symbol);
  });

  socket.on("disconnect", ()=>{
    console.log("cliente desconectado:", socket.id);
  });
});

/* ---------------- SPA FALLBACK ---------------- */

app.get("*",(req,res)=>{
  res.sendFile(path.join(__dirname,"public/index.html"));
});

/* ---------------- ERROR HANDLER ---------------- */

app.use((err,req,res,next)=>{
  console.error(err);
  res.status(500).json({error:"Server error"});
});

/* ---------------- START ---------------- */

const PORT = process.env.PORT || 3000;

server.listen(PORT,()=>{
  console.log("Servidor corriendo en puerto",PORT);
});

/* ---------------- SHUTDOWN ---------------- */

process.on("SIGINT",()=>process.exit());
process.on("SIGTERM",()=>process.exit());

export default app;
