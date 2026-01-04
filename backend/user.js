import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  password: String,
  balance: { type: Number, default: 0 },
  leverage: { type: Number, default: 1 },
  role: { type: String, enum: ['user','admin'], default: 'user' },
  verified: { type: Boolean, default: false }
},{ timestamps:true });

export default mongoose.model('User', userSchema);
