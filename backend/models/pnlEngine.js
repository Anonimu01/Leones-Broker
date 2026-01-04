function calculatePnL(entry, price, qty, leverage){
  return ((price - entry) * qty) * leverage;
}
module.exports = { calculatePnL };
