const express = require("express");
const cors = require("cors");
const statusRoutes = require("./routes/statusRoutes");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/status", statusRoutes);

app.listen(5000, () => {
  console.log("Backend running at http://localhost:5000");
});
