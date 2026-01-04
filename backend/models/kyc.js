const mongoose = require('mongoose');

module.exports = mongoose.model('Kyc', new mongoose.Schema({
  userId: mongoose.Types.ObjectId,
  documentId: String,
  proofAddress: String,
  status: {type:String, default:'pending'} // pending | approved | rejected
}));
