const User = require('./models/User');
const bcrypt = require('bcrypt');

async function createAdmin(){
  const exists = await User.findOne({role:'admin'});
  if(!exists){
    await User.create({
      email: 'admin@leones.com',
      password: await bcrypt.hash('Admin123!',10),
      role: 'admin',
      verified: true
    });
    console.log('✅ Admin creado');
  }
}
createAdmin();
