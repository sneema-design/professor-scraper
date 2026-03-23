require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const scrapeRoute = require("./router/scrapeRoute.js");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/api", scrapeRoute);

app.listen(PORT, () => {
  console.log(`\n🎓  Uni Scraper  →  http://localhost:${PORT}`);
  console.log(`    Playwright + Groq (${process.env.GROQ_MODEL || "llama-3.1-8b-instant"})\n`);
});