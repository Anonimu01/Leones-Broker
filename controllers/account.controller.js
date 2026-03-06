// controllers/account.controller.js

export const getAccount = async (req, res) => {
  res.json({
    ok: true,
    message: "Account info",
    user: req.user || null
  });
};

export const updateAccount = async (req, res) => {
  res.json({
    ok: true,
    message: "Account updated",
    data: req.body
  });
};

export const getAccountBalance = async (req, res) => {
  res.json({
    ok: true,
    balance: 0
  });
};
