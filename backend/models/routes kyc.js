router.post('/upload', auth, async(req,res)=>{
  await Kyc.create({
    userId: req.user.id,
    documentId: req.body.doc,
    proofAddress: req.body.address
  });
  res.json({msg:'KYC enviado'});
});
