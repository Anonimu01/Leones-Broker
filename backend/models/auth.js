const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const User = require('../models/User');

router.post('/login', async(req,res)=>{
  const {email,password} = req.body;
  const user = await User.findOne({email});
  if(!user) return res.status(401).json({msg:'No existe'});

  const ok = await bcrypt.compare(password,user.password);
  if(!ok) return res.status(401).json({msg:'Clave incorrecta'});

  const token = jwt.sign(
    {id:user._id, role:user.role},
    process.env.JWT_SECRET,
    {expiresIn:'24h'}
  );

  res.json({token, role:user.role});
});
