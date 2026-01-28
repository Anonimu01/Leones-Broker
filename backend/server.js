const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config();

const authRoutes = require('./routes.auth');
const userRoutes = require('./routes.user');
const withdrawRoutes = require('./routes.withdraw');
const adminRoutes = require('./admin');
const verifyRoutes = require('./verification');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

mongoose.connect(process.env.MONGO_URI)
.then(()=>console.log('✅ MongoDB conectado'))
.catch(err=>console.log(err));

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/withdraw', withdrawRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/verify', verifyRoutes);

app.get('/', (req,res)=>{
  res.sendFile(__dirname + '/public/index.html');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>{
  console.log('🚀 Servidor corriendo en puerto', PORT);
});
