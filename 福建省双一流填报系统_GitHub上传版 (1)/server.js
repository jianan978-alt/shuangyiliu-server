// server.js — 福建省"双一流"建设监测数据 在线填报系统 后端
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const archiver = require("archiver");

const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_ROOT = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const DISCIPLINES = ["chem", "chem_eng"];
const DISCIPLINE_NAMES = { chem: "化学学科", chem_eng: "化工学科" };

const INDICATORS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data", "indicators.json"), "utf-8")
);
const INDICATOR_BY_ID = {};
INDICATORS.forEach((ind) => (INDICATOR_BY_ID[ind.id] = ind));

function ownersFor(ind, discipline) {
  return (ind.owner_by_discipline && ind.owner_by_discipline[discipline]) || ind.owner_list || [];
}

function leadersFor(ind) {
  if (!ind.leader) return [];
  return String(ind.leader).replace(/\u3000/g, " ").split(/\s+/).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function validDiscipline(req, res, next) {
  const d = req.params.discipline;
  if (!DISCIPLINES.includes(d)) {
    return res.status(400).json({ error: "invalid discipline" });
  }
  next();
}

// Multer: keep files on disk under uploads/<discipline>/<indicatorId>/<kind>/
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const { discipline, indicatorId, kind } = req.params;
    const dir = path.join(UPLOAD_ROOT, discipline, indicatorId, kind);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const rand = crypto.randomBytes(6).toString("hex");
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    // keep a readable prefix + random suffix to avoid collisions
    cb(null, `${Date.now()}_${rand}${ext}`);
  },
});
const upload = multer({ storage }); // no size/type limits per requirements

// ---------------------------------------------------------------------------
// Indicators metadata
// ---------------------------------------------------------------------------
app.get("/api/indicators", (req, res) => {
  res.json({ indicators: INDICATORS, disciplines: DISCIPLINES.map((id) => ({ id, name: DISCIPLINE_NAMES[id] })) });
});

app.get("/api/people/:discipline", validDiscipline, (req, res) => {
  const { discipline } = req.params;
  const set = new Set();
  INDICATORS.forEach((ind) => ownersFor(ind, discipline).forEach((p) => set.add(p)));
  res.json({ people: Array.from(set).sort((a, b) => a.localeCompare(b, "zh")) });
});

// All distinct 分管领导 names, across all indicators (leaders are not discipline-specific).
app.get("/api/leaders", (req, res) => {
  const set = new Set();
  INDICATORS.forEach((ind) => leadersFor(ind).forEach((l) => set.add(l)));
  res.json({ leaders: Array.from(set).sort((a, b) => a.localeCompare(b, "zh")) });
});

// ---------------------------------------------------------------------------
// Fields (text values)
// ---------------------------------------------------------------------------

// Get all field values + file lists for one discipline (used on load)
app.get("/api/state/:discipline", validDiscipline, (req, res) => {
  const { discipline } = req.params;

  const fieldRows = db
    .prepare(`SELECT indicator_id, item_idx, value FROM fields WHERE discipline = ?`)
    .all(discipline);
  const fields = {};
  fieldRows.forEach((r) => {
    fields[`${r.indicator_id}:${r.item_idx}`] = r.value;
  });

  const fileRows = db
    .prepare(
      `SELECT id, indicator_id, kind, original_name, size_bytes, mime_type, uploaded_by, uploaded_at
       FROM files WHERE discipline = ? ORDER BY uploaded_at ASC`
    )
    .all(discipline);
  const evidence = {};
  const listFiles = {};
  fileRows.forEach((r) => {
    const bucket = r.kind === "evidence" ? evidence : listFiles;
    if (!bucket[r.indicator_id]) bucket[r.indicator_id] = [];
    bucket[r.indicator_id].push({
      id: r.id,
      name: r.original_name,
      size: r.size_bytes,
      type: r.mime_type,
      uploadedBy: r.uploaded_by,
      uploadedAt: r.uploaded_at,
      url: `/api/file/${r.id}`,
    });
  });

  res.json({ fields, evidence, listFiles });
});

// Save one text field
app.put("/api/field/:discipline/:indicatorId/:itemIdx", validDiscipline, (req, res) => {
  const { discipline, indicatorId, itemIdx } = req.params;
  const { value, person } = req.body || {};
  if (typeof value !== "string") return res.status(400).json({ error: "value must be a string" });

  db.prepare(
    `INSERT INTO fields (discipline, indicator_id, item_idx, value, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(discipline, indicator_id, item_idx)
     DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(discipline, indicatorId, Number(itemIdx), value, person || null);

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Files (evidence / list uploads)
// ---------------------------------------------------------------------------

// Upload one or more files to a slot: evidence or list
app.post(
  "/api/upload/:discipline/:indicatorId/:kind",
  validDiscipline,
  (req, res, next) => {
    if (!["evidence", "list"].includes(req.params.kind)) {
      return res.status(400).json({ error: "invalid kind" });
    }
    next();
  },
  upload.array("files"),
  (req, res) => {
    const { discipline, indicatorId, kind } = req.params;
    const person = req.body.person || null;
    const inserted = [];

    const insertStmt = db.prepare(
      `INSERT INTO files (discipline, indicator_id, kind, original_name, stored_name, size_bytes, mime_type, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    (req.files || []).forEach((f) => {
      const info = insertStmt.run(
        discipline,
        indicatorId,
        kind,
        f.originalname,
        f.filename,
        f.size,
        f.mimetype,
        person
      );
      inserted.push({
        id: info.lastInsertRowid,
        name: f.originalname,
        size: f.size,
        type: f.mimetype,
        uploadedBy: person,
        url: `/api/file/${info.lastInsertRowid}`,
      });
    });

    db.prepare(
      `INSERT INTO activity_log (discipline, person, action, detail) VALUES (?, ?, 'upload', ?)`
    ).run(discipline, person, `${indicatorId} ${kind} x${inserted.length}`);

    res.json({ ok: true, files: inserted });
  }
);

// Download / view a single file by id
app.get("/api/file/:fileId", (req, res) => {
  const row = db.prepare(`SELECT * FROM files WHERE id = ?`).get(req.params.fileId);
  if (!row) return res.status(404).send("Not found");
  const filePath = path.join(UPLOAD_ROOT, row.discipline, row.indicator_id, row.kind, row.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).send("File missing on disk");
  res.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(row.original_name)}`
  );
  if (row.mime_type) res.setHeader("Content-Type", row.mime_type);
  fs.createReadStream(filePath).pipe(res);
});

// Delete a file
app.delete("/api/file/:fileId", (req, res) => {
  const row = db.prepare(`SELECT * FROM files WHERE id = ?`).get(req.params.fileId);
  if (!row) return res.status(404).json({ error: "not found" });
  const filePath = path.join(UPLOAD_ROOT, row.discipline, row.indicator_id, row.kind, row.stored_name);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error("failed to remove file from disk", e);
  }
  db.prepare(`DELETE FROM files WHERE id = ?`).run(req.params.fileId);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

function computeProgress(discipline) {
  const fieldRows = db
    .prepare(`SELECT indicator_id, item_idx, value FROM fields WHERE discipline = ?`)
    .all(discipline);
  const fieldMap = {};
  fieldRows.forEach((r) => {
    fieldMap[`${r.indicator_id}:${r.item_idx}`] = r.value;
  });

  const fileCounts = db
    .prepare(
      `SELECT indicator_id, kind, COUNT(*) as cnt FROM files WHERE discipline = ? GROUP BY indicator_id, kind`
    )
    .all(discipline);
  const fileMap = {}; // indicatorId -> {evidence: n, list: n}
  fileCounts.forEach((r) => {
    if (!fileMap[r.indicator_id]) fileMap[r.indicator_id] = {};
    fileMap[r.indicator_id][r.kind] = r.cnt;
  });

  const perIndicator = {};
  const perPerson = {};
  const perLeader = {};

  INDICATORS.forEach((ind) => {
    const textItems = ind.items.filter((it) => !it.is_list);
    let textDone = 0;
    textItems.forEach((it) => {
      const idx = ind.items.indexOf(it);
      const val = fieldMap[`${ind.id}:${idx}`];
      if (val && val.trim().length > 0) textDone += 1;
    });
    const needsList = ind.items.some((it) => it.is_list);
    const listDone = !needsList || (fileMap[ind.id] && fileMap[ind.id].list > 0);
    const evidenceDone = fileMap[ind.id] && fileMap[ind.id].evidence > 0;

    const total = textItems.length + (needsList ? 1 : 0) + 1;
    const done = textDone + (needsList ? (listDone ? 1 : 0) : 0) + (evidenceDone ? 1 : 0);

    perIndicator[ind.id] = { done, total };

    ownersFor(ind, discipline).forEach((person) => {
      if (!perPerson[person]) perPerson[person] = { done: 0, total: 0, indicatorCount: 0 };
      perPerson[person].done += done;
      perPerson[person].total += total;
      perPerson[person].indicatorCount += 1;
    });

    leadersFor(ind).forEach((leader) => {
      if (!perLeader[leader]) perLeader[leader] = { done: 0, total: 0, indicatorCount: 0 };
      perLeader[leader].done += done;
      perLeader[leader].total += total;
      perLeader[leader].indicatorCount += 1;
    });
  });

  let overallDone = 0;
  let overallTotal = 0;
  Object.values(perIndicator).forEach((p) => {
    overallDone += p.done;
    overallTotal += p.total;
  });

  return { perIndicator, perPerson, perLeader, overall: { done: overallDone, total: overallTotal } };
}

app.get("/api/progress/:discipline", validDiscipline, (req, res) => {
  res.json(computeProgress(req.params.discipline));
});

// Leader dashboard: combines both disciplines, showing only indicators this leader oversees,
// broken down by discipline and by the responsible person. Read-only view.
app.get("/api/leader-view/:leader", (req, res) => {
  const leaderName = req.params.leader;
  const relevantIndicatorIds = new Set(
    INDICATORS.filter((ind) => leadersFor(ind).includes(leaderName)).map((ind) => ind.id)
  );

  if (relevantIndicatorIds.size === 0) {
    return res.json({ leader: leaderName, disciplines: {}, overall: { done: 0, total: 0 } });
  }

  const result = { leader: leaderName, disciplines: {}, overall: { done: 0, total: 0 } };

  DISCIPLINES.forEach((discipline) => {
    const full = computeProgress(discipline);
    const indicatorsForLeader = INDICATORS.filter((ind) => relevantIndicatorIds.has(ind.id));

    let done = 0;
    let total = 0;
    const byPerson = {};
    const byIndicator = [];

    indicatorsForLeader.forEach((ind) => {
      const stat = full.perIndicator[ind.id] || { done: 0, total: 0 };
      done += stat.done;
      total += stat.total;
      byIndicator.push({
        id: ind.id,
        l1: ind.l1,
        l2: ind.l2,
        l3: ind.l3,
        owners: ownersFor(ind, discipline),
        done: stat.done,
        total: stat.total,
      });
      ownersFor(ind, discipline).forEach((person) => {
        if (!byPerson[person]) byPerson[person] = { done: 0, total: 0, indicatorCount: 0 };
        byPerson[person].done += stat.done;
        byPerson[person].total += stat.total;
        byPerson[person].indicatorCount += 1;
      });
    });

    result.disciplines[discipline] = {
      name: DISCIPLINE_NAMES[discipline],
      overall: { done, total },
      byPerson,
      byIndicator,
    };
    result.overall.done += done;
    result.overall.total += total;
  });

  res.json(result);
});

// ---------------------------------------------------------------------------
// Export — build a nested folder structure by indicator hierarchy and zip it
// ---------------------------------------------------------------------------

function sanitizeName(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim()
    .slice(0, 120);
}

app.get("/api/export/:discipline", validDiscipline, (req, res) => {
  const { discipline } = req.params;
  const disciplineName = DISCIPLINE_NAMES[discipline];

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(disciplineName + "_填报材料导出_" + new Date().toISOString().slice(0, 10) + ".zip")}"`
  );

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    console.error("archive error", err);
    res.status(500).end();
  });
  archive.pipe(res);

  // Pull all field values and files for this discipline up front
  const fieldRows = db
    .prepare(`SELECT indicator_id, item_idx, value FROM fields WHERE discipline = ?`)
    .all(discipline);
  const fieldMap = {};
  fieldRows.forEach((r) => {
    fieldMap[`${r.indicator_id}:${r.item_idx}`] = r.value;
  });

  const fileRows = db
    .prepare(`SELECT * FROM files WHERE discipline = ? ORDER BY indicator_id, kind, uploaded_at`)
    .all(discipline);
  const filesByIndicator = {};
  fileRows.forEach((r) => {
    if (!filesByIndicator[r.indicator_id]) filesByIndicator[r.indicator_id] = [];
    filesByIndicator[r.indicator_id].push(r);
  });

  // Build folder path per indicator: 1.人才培养/1.1思想政治教育/1.1.1xxx/
  INDICATORS.forEach((ind) => {
    const folder = [sanitizeName(ind.l1), sanitizeName(ind.l2), sanitizeName(ind.l3)].join("/");

    // 1) a text summary file for this indicator's fields
    const lines = [];
    lines.push(`三级指标：${ind.l3}`);
    lines.push(`负责人（${disciplineName}）：${(ownersFor(ind, discipline) || []).join("、") || "（未指定）"}`);
    lines.push("");
    ind.items.forEach((it, idx) => {
      if (it.is_list) return; // list items are represented by uploaded files, not text
      const val = fieldMap[`${ind.id}:${idx}`] || "";
      lines.push(`【${it.item}】`);
      lines.push(val || "（未填写）");
      lines.push("");
    });
    const summaryText = lines.join("\n");
    archive.append(Buffer.from(summaryText, "utf-8"), {
      name: `${folder}/填报内容.txt`,
    });

    // 2) uploaded files (evidence + list), placed in subfolders
    const files = filesByIndicator[ind.id] || [];
    files.forEach((f) => {
      const filePath = path.join(UPLOAD_ROOT, discipline, ind.id, f.kind, f.stored_name);
      if (!fs.existsSync(filePath)) return;
      const subDir = f.kind === "evidence" ? "佐证材料" : "清单文件";
      archive.file(filePath, {
        name: `${folder}/${subDir}/${sanitizeName(f.original_name)}`,
      });
    });
  });

  archive.finalize();
});

// ---------------------------------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`福建省"双一流"填报系统后端已启动： http://0.0.0.0:${PORT}`);
});
