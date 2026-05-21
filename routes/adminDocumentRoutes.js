const express = require("express");
const router = express.Router();

const Document = require("../models/Document");
const User = require("../models/User");

const authAdmin = require("../middleware/authAdmin");

const sendEmail = require("../utils/sendEmail");

/* =====================================================
GET USER DOCUMENTS
===================================================== */
router.get("/documents/:id", authAdmin, async (req, res) => {

try {

```
const docs = await Document.find({
  userId: req.params.id
}).sort({ createdAt: -1 });

return res.json(docs);
```

} catch (err) {

```
console.error(err);

return res.status(500).json({
  msg: "Error loading documents"
});
```

}
});

/* =====================================================
APPROVE DOCUMENT
===================================================== */
router.post("/document/approve", authAdmin, async (req, res) => {

try {

```
const { id } = req.body;

const doc = await Document.findById(id);

if (!doc) {
  return res.status(404).json({
    msg: "Document not found"
  });
}

doc.status = "approved";

await doc.save();

const user = await User.findById(doc.userId);

if (user?.email) {

  await sendEmail(
    user.email,
    "Documento aprobado",
    `
    <h2>Documento aprobado</h2>
    <p>Su documento fue aprobado correctamente.</p>
    `
  );
}

return res.json({
  success: true
});
```

} catch (err) {

```
console.error(err);

return res.status(500).json({
  msg: "Error approving document"
});
```

}
});

/* =====================================================
REJECT DOCUMENT
===================================================== */
router.post("/document/reject", authAdmin, async (req, res) => {

try {

```
const { id } = req.body;

const doc = await Document.findById(id);

if (!doc) {
  return res.status(404).json({
    msg: "Document not found"
  });
}

doc.status = "rejected";

await doc.save();

const user = await User.findById(doc.userId);

if (user?.email) {

  await sendEmail(
    user.email,
    "Documento rechazado",
    `
    <h2>Documento rechazado</h2>
    <p>Su documento fue rechazado.</p>
    `
  );
}

return res.json({
  success: true
});
```

} catch (err) {

```
console.error(err);

return res.status(500).json({
  msg: "Error rejecting document"
});
```

}
});

module.exports = router;
