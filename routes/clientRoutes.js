const express = require("express");
const router = express.Router();

const multer = require("multer");
const path = require("path");

const Withdraw = require("../models/Withdraw");
const Document = require("../models/Document");

const auth = require("../middleware/auth");

/* =====================================================
STORAGE
===================================================== */
const storage = multer.diskStorage({

destination: (req, file, cb) => {
cb(null, "uploads/");
},

filename: (req, file, cb) => {

```
const unique =
  Date.now() + "-" + Math.round(Math.random() * 1e9);

cb(
  null,
  unique + path.extname(file.originalname)
);
```

}

});

const upload = multer({ storage });

/* =====================================================
CREATE WITHDRAW
===================================================== */
router.post("/withdraw", auth, async (req, res) => {

try {

```
const {
  amount,
  wallet,
  network
} = req.body;

const withdraw = await Withdraw.create({

  userId: req.user.id,

  amount,

  wallet,

  network,

  status: "pending"

});

return res.json({
  success: true,
  withdraw
});
```

} catch (err) {

```
console.error(err);

return res.status(500).json({
  msg: "Withdraw error"
});
```

}
});

/* =====================================================
UPLOAD DOCUMENT
===================================================== */
router.post(
"/upload-document",
auth,
upload.single("document"),
async (req, res) => {

```
try {

  if (!req.file) {
    return res.status(400).json({
      msg: "No file uploaded"
    });
  }

  const document = await Document.create({

    userId: req.user.id,

    type: req.body.type || "identity",

    documentUrl:
      "/uploads/" + req.file.filename,

    status: "pending"

  });

  return res.json({
    success: true,
    document
  });

} catch (err) {

  console.error(err);

  return res.status(500).json({
    msg: "Upload error"
  });
}
```

}
);

module.exports = router;
