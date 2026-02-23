import express from "express";

export default function marketRoutesFactory(deps){

  const router = express.Router();
  const polygonSocket = deps.polygonSocket;

  router.post("/subscribe", (req, res) => {
    const { symbol, kind } = req.body || {};

    if(!symbol){
      return res.status(400).json({ ok:false, msg:"symbol required" });
    }

    try{
      polygonSocket.subscribe(symbol, kind || "trades");
      return res.json({
        ok:true,
        subscribed: symbol,
        kind: kind || "trades"
      });
    }catch(e){
      return res.status(500).json({ ok:false, msg:String(e) });
    }
  });


  router.post("/unsubscribe", (req, res) => {
    const { symbol, kind } = req.body || {};

    if(!symbol){
      return res.status(400).json({ ok:false, msg:"symbol required" });
    }

    try{
      polygonSocket.unsubscribe(symbol, kind || "trades");
      return res.json({
        ok:true,
        unsubscribed: symbol,
        kind: kind || "trades"
      });
    }catch(e){
      return res.status(500).json({ ok:false, msg:String(e) });
    }
  });


  router.get("/subscriptions", (req, res) => {
    try{
      const list = polygonSocket.listSubscriptions();
      res.json({ ok:true, list });
    }catch(e){
      res.status(500).json({ ok:false, msg:String(e) });
    }
  });


  return router;
}
