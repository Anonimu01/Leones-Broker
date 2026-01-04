import mongoose from 'mongoose';

const withdrawSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  amount: Number,
  status: { type: String, default: 'pending' }
},{ timestamps:true });

export default mongoose.model('Withdraw', withdrawSchema);
