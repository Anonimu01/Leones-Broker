const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  email: String,
  password: String,
  role: { type: String, default: 'user' }, // user | admin
  balance: { type: Number, default: 0 },
  leverage: { type: Number, default: 1 },
  verified: { type: Boolean, default: false }
});

module.exports = mongoose.model('User', UserSchema);
