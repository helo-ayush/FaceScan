const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS for frontend app
app.use(cors());
app.use(express.json());

// Simple login verification route
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const envUsername = process.env.ADMIN_USERNAME;
  const envPassword = process.env.ADMIN_PASSWORD;

  if (username === envUsername && password === envPassword) {
    return res.status(200).json({ success: true, message: "Authentication successful" });
  } else {
    return res.status(401).json({ success: false, message: "Invalid username or password" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend authentication server running on port ${PORT}`);
});
