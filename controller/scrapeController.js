const { runAgent } = require("../agent");
const db          = require("../models");
const ScrapeJob   = db.ScrapJob;
const Professor   = db.Professor;

const sseStreaming = async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing ?url= parameter" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (type, data) =>
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);

  send("start", { message: `Agent starting for: ${url}` });

  const job = await ScrapeJob.create({
    url,
    universityName: "",
    status: "running",
    startedAt: new Date(),
  });

  send("log", { message: `📦 Job created: #${job.id}` });

  try {
    const report = await runAgent(url, (msg) => send("log", { message: msg }));

    if (report.professors.length > 0) {
      await Professor.bulkCreate(
        report.professors.map((p) => ({
          jobId:      job.id,
          name:       p.name       || null,
          title:      p.title      || null,
          department: p.department || null,
          email:      p.email      || null,
          phone:      p.phone      || null,
          research:   p.research   || null,
          profileUrl: p.profileUrl || null,
        })),
        { ignoreDuplicates: true }
      );
    }

    await job.update({
      universityName: report.universityName,
      status:         "completed",
      totalFound:     report.stats.total,
      pagesScraped:   report.stats.pagesScraped,
      finishedAt:     new Date(),
    });

    send("result", { ...report, jobId: job.id });

    send("summary", {
      message:
        `\n========== FINAL RESULTS ==========\n` +
        `Job ID       : ${job.id}\n` +
        `University   : ${report.universityName}\n` +
        `Total Found  : ${report.stats.total}\n` +
        `With Email   : ${report.stats.withEmail}\n` +
        `With Phone   : ${report.stats.withPhone}\n` +
        `With Dept    : ${report.stats.withDepartment}\n` +
        `Pages Scraped: ${report.stats.pagesScraped}\n` +
        `====================================\n`,
    });

    report.professors.forEach((p, i) => {
      send("professor", {
        index: i + 1,
        data:  p,
        message:
          `[${i + 1}] ${p.name}` +
          (p.title      ? ` | ${p.title}`      : "") +
          (p.department ? ` | ${p.department}` : "") +
          (p.email      ? ` | ${p.email}`      : "") +
          (p.phone      ? ` | ${p.phone}`      : "") +
          (p.research   ? ` | ${p.research}`   : "") +
          (p.profileUrl ? ` | ${p.profileUrl}` : ""),
      });
    });

    send("done", { message: `Done. ${report.stats.total} professors saved to DB under Job #${job.id}.` });

  } catch (err) {
    await job.update({
      status:     "failed",
      error:      err.message,
      finishedAt: new Date(),
    });
    send("error", { message: err.message });
  }

  res.end();
};

const rest = async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url" });
  try {
    res.json(await runAgent(url));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const csvExport = async (req, res) => {
  try {
    const { professors = [], universityName = "university" } = req.body;
    const headers = ["Name", "Title", "Department", "Email", "Phone", "Research", "Profile URL"];
    const rows = professors.map((p) =>
      [p.name, p.title, p.department, p.email, p.phone, p.research, p.profileUrl]
        .map((v) => `"${(v || "").replace(/"/g, '""')}"`)
        .join(",")
    );
    const csv      = [headers.join(","), ...rows].join("\n");
    const filename = `${universityName.replace(/[^a-z0-9]/gi, "_")}_faculty.csv`;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getAllJobs = async (req, res) => {
  try {
    const jobs = await ScrapeJob.findAll({
      order: [["createdAt", "DESC"]],
      attributes: ["id", "url", "universityName", "status", "totalFound", "pagesScraped", "startedAt", "finishedAt"],
    });
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getJobWithProfessors = async (req, res) => {
  try {
    const job = await ScrapeJob.findByPk(req.params.jobId, {
      include: [{ model: Professor, as: "professors" }],
    });
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const exportJobCsv = async (req, res) => {
  try {
    const job = await ScrapeJob.findByPk(req.params.jobId, {
      include: [{ model: Professor, as: "professors" }],
    });
    if (!job) return res.status(404).json({ error: "Job not found" });

    const headers  = ["Name", "Title", "Department", "Email", "Phone", "Research", "Profile URL"];
    const rows     = job.professors.map((p) =>
      [p.name, p.title, p.department, p.email, p.phone, p.research, p.profileUrl]
        .map((v) => `"${(v || "").replace(/"/g, '""')}"`)
        .join(",")
    );
    const csv      = [headers.join(","), ...rows].join("\n");
    const filename = `${(job.universityName || "university").replace(/[^a-z0-9]/gi, "_")}_faculty.csv`;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { rest, sseStreaming, csvExport, getAllJobs, getJobWithProfessors, exportJobCsv };