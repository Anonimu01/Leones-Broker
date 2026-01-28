const express = require("express");
const path = require("path");
const app = express();

app.use(express.json());

// =====================
// FRONT CLIENTE
// =====================
app.use(
  "/",
  express.static(path.join(__dirname, "public_web"))
);

// =====================
// FRONT ADMIN
// =====================
app.use(
  "/admin",
  express.static(path.join(__dirname, "public"))
);

// =====================
// API
// =====================
app.use("/api/auth", require("./routes/auth"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/user", require("./routes/user"));
app.use("/api/withdraw", require("./routes/withdraw"));

// =====================
app.get("*", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public_web", "index.html")
  );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("Servidor activo en puerto", PORT)
);
