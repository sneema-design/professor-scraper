const express = require("express");
const {
  sseStreaming, rest, csvExport,
  getAllJobs, getJobWithProfessors, exportJobCsv,
} = require("../controller/scrapeController.js");

const route = express.Router();

route.get("/scrape",                 sseStreaming);
route.post("/scrape",                rest);
route.post("/export/csv",            csvExport);
route.get("/jobs",                   getAllJobs);
route.get("/jobs/:jobId",            getJobWithProfessors);
route.get("/jobs/:jobId/export",     exportJobCsv);

module.exports = route;