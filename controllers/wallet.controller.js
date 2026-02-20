import User from "../models/user.model.js";

export const getMyWallet = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("balance name email");

    if (!user)
      return res.status(404).json({ msg: "Usuario no encontrado" });

    res.json({
      balance: user.balance ?? 0,
      name: user.name,
      email: user.email
    });

  } catch (err) {
    console.error("Wallet error:", err);
    res.status(500).json({ msg: "Error servidor" });
  }
};
