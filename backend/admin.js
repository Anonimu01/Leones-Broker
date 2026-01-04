import express from 'express';
import User from '../models/User.js';
import Withdraw from '../models/Withdraw.js';
import { auth } from '../middleware/auth.js';

const router = express.Router();

router.get('/users', auth('admin'), async(req,res)=>{
  res.json(await User.find());
});

router.post('/update-balance', auth('admin'), async(req,res)=>{
  const {userId,balance} = req.body;
  await User.findByIdAndUpdate(userId,{balance});
  res.json({ok:true});
});

router.post('/update-leverage', auth('admin'), async(req,res)=>{
  const {userId,leverage} = req.body;
  await User.findByIdAndUpdate(userId,{leverage});
  res.json({ok:true});
});

router.get('/withdraws/:id', auth('admin'), async(req,res)=>{
  res.json(await Withdraw.find({userId:req.params.id,status:'pending'}));
});

router.post('/withdraw/approve', auth('admin'), async(req,res)=>{
  await Withdraw.findByIdAndUpdate(req.body.id,{status:'approved'});
  res.json({ok:true});
});

router.post('/withdraw/reject', auth('admin'), async(req,res)=>{
  await Withdraw.findByIdAndUpdate(req.body.id,{status:'rejected'});
  res.json({ok:true});
});

export default router;
