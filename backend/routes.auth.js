import jwt from 'jsonwebtoken';

export const auth = (role=null) => {
  return (req,res,next)=>{
    const token = req.headers.authorization?.split(' ')[1];
    if(!token) return res.status(401).json({msg:'No autorizado'});

    try{
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if(role && decoded.role !== role){
        return res.status(403).json({msg:'Acceso denegado'});
      }
      req.user = decoded;
      next();
    }catch{
      res.status(401).json({msg:'Token inválido'});
    }
  }
}
