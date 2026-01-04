const { calculatePnL } = require('./pnlEngine');

function updateUserBalance(user, position, price){
  const pnl = calculatePnL(
    position.entry,
    price,
    position.qty,
    user.leverage
  );
  user.balance += pnl;
  return pnl;
}
