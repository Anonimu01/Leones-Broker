import express from 'express';
import { auth } from '../middleware/auth.js';
import User from '../models/User.js';

const router = express.Router();

router.get('/me', auth(), async(req,res)=>{
  res.json(await User.findById(req.user.id));
});

export default router;
