// خادم مقياس الدافعية للتعلم — بدون أي مكتبات خارجية (Node.js فقط)
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const SUB_DIR = path.join(DATA_DIR, "submissions");
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const CID_DIR = path.join(DATA_DIR, "client-ids");
fs.mkdirSync(SUB_DIR, { recursive: true });
fs.mkdirSync(CID_DIR, { recursive: true });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Accept", "Cache-Control": "no-store" };

const Q = Array.from({ length: 57 }, (_, i) => `Q${String(i + 1).padStart(2, "0")}`);
const EDU = ["below_university", "university", "master", "doctorate"];
const EDU_AR = { below_university: "أقل من جامعي", university: "جامعي", master: "ماجستير", doctorate: "دكتوراه" };

function send(res, code, body, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(code, { "Content-Type": type, ...extra });
  res.end(body);
}
function json(res, code, obj, extra = {}) { send(res, code, JSON.stringify(obj, null, 2), "application/json; charset=utf-8", extra); }

function readBody(req, limit = 200000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cleanText(v, max) { return String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max); }

function validate(d) {
  if (!d || typeof d !== "object") return [null, "بيانات غير صالحة"];
  const out = {
    grade: cleanText(d.grade, 50),
    family_count: cleanText(d.family_count, 10),
    father_education: d.father_education,
    mother_education: d.mother_education,
  };
  if (!out.grade) return [null, "الصف مطلوب"];
  if (!out.family_count) return [null, "عدد أفراد الأسرة مطلوب"];
  if (!EDU.includes(out.father_education)) return [null, "تعليم الأب غير صالح"];
  if (!EDU.includes(out.mother_education)) return [null, "تعليم الأم غير صالح"];
  const answers = {};
  for (const q of Q) {
    const n = Number(d[q]);
    if (!Number.isInteger(n) || n < 1 || n > 5) return [null, `الإجابة ${q} غير صالحة`];
    answers[q] = n;
  }
  return [{ ...out, answers }, null];
}

function loadAll() {
  return fs.readdirSync(SUB_DIR).filter(f => f.endsWith(".json")).sort().map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(SUB_DIR, f), "utf8")); } catch { return null; }
  }).filter(Boolean);
}

function stats(all) {
  const n = all.length;
  const perQ = Q.map(q => {
    const dist = [0, 0, 0, 0, 0]; let sum = 0;
    all.forEach(s => { const v = s.answers[q]; dist[v - 1]++; sum += v; });
    const mean = n ? sum / n : 0;
    const sd = n ? Math.sqrt(all.reduce((a, s) => a + (s.answers[q] - mean) ** 2, 0) / n) : 0;
    return { question: q, mean: +mean.toFixed(3), sd: +sd.toFixed(3), distribution: { 1: dist[0], 2: dist[1], 3: dist[2], 4: dist[3], 5: dist[4] } };
  });
  const totals = all.map(s => s.total_score);
  const overallMean = n ? totals.reduce((a, b) => a + b, 0) / n : 0;
  const count = key => all.reduce((m, s) => { const k = s[key]; m[k] = (m[k] || 0) + 1; return m; }, {});
  const byGrade = {};
  all.forEach(s => { (byGrade[s.grade] ||= []).push(s.total_score); });
  return {
    generated_at: new Date().toISOString(),
    students_count: n,
    total_score: { mean: +overallMean.toFixed(2), min: n ? Math.min(...totals) : 0, max: n ? Math.max(...totals) : 0, max_possible: 285 },
    grades: count("grade"),
    father_education: count("father_education"),
    mother_education: count("mother_education"),
    mean_total_by_grade: Object.fromEntries(Object.entries(byGrade).map(([g, a]) => [g, +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2)])),
    questions: perQ,
  };
}

function csvEscape(v) { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function toCSV(all) {
  const head = ["id", "submitted_at", "grade", "family_count", "father_education", "mother_education", ...Q, "total_score", "mean_score"];
  const rows = all.map(s => [s.id, s.submitted_at, s.grade, s.family_count, EDU_AR[s.father_education], EDU_AR[s.mother_education], ...Q.map(q => s.answers[q]), s.total_score, s.mean_score]);
  return "\uFEFF" + [head, ...rows].map(r => r.map(csvEscape).join(",")).join("\r\n");
}
function statsCSV(st) {
  const head = ["العبارة", "المتوسط", "الانحراف المعياري", "1", "2", "3", "4", "5"];
  const rows = st.questions.map(q => [q.question, q.mean, q.sd, ...[1, 2, 3, 4, 5].map(k => q.distribution[k])]);
  return "\uFEFF" + [head, ...rows].map(r => r.map(csvEscape).join(",")).join("\r\n");
}

// --- ZIP بسيط (بدون ضغط) ---
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function makeZip(files) {
  const parts = [], central = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8"), data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, "utf8"), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(0, 12); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42); central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

function authed(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const [u, ...p] = Buffer.from(h.slice(6), "base64").toString().split(":");
  const a = Buffer.from(`${u}:${p.join(":")}`), b = Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (req.method === "GET" && (p === "/" || p === "/index.html"))
      return send(res, 200, fs.readFileSync(path.join(__dirname, "public", "index.html")), "text/html; charset=utf-8");

    if (req.method === "OPTIONS" && (p === "/api/answers" || p === "/health")) { res.writeHead(204, CORS); return res.end(); }

    if (req.method === "POST" && p === "/api/answers") {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, error: "JSON غير صالح" }, CORS); }
      const [clean, err] = validate(body);
      if (err) return json(res, 400, { ok: false, error: err }, CORS);
      // منع التكرار: إذا أعاد الجهاز إرسال نفس الحل (بسبب إعادة المحاولة) نرجع نفس المعرف
      const cid = /^[a-z0-9]{8,40}$/i.test(String(body.client_id || "")) ? String(body.client_id) : null;
      const cidFile = cid ? path.join(CID_DIR, cid) : null;
      if (cidFile && fs.existsSync(cidFile)) return json(res, 200, { ok: true, id: fs.readFileSync(cidFile, "utf8"), duplicate: true }, CORS);
      const now = new Date();
      const id = `${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`;
      const total = Q.reduce((a, q) => a + clean.answers[q], 0);
      const record = { id, form_version: cleanText(body.form_version, 40) || "motivation-scale-v1", submitted_at: now.toISOString(), ...clean, total_score: total, mean_score: +(total / 57).toFixed(3) };
      fs.writeFileSync(path.join(SUB_DIR, `${id}.json`), JSON.stringify(record, null, 2));
      if (cidFile) fs.writeFileSync(cidFile, id);
      return json(res, 200, { ok: true, id }, CORS);
    }

    if (req.method === "GET" && p === "/health") return json(res, 200, { ok: true }, CORS);

    if (p.startsWith("/admin")) {
      if (!authed(req)) return send(res, 401, "مطلوب تسجيل الدخول", "text/plain; charset=utf-8", { "WWW-Authenticate": 'Basic realm="admin", charset="UTF-8"' });
      const all = loadAll();
      const day = new Date().toISOString().slice(0, 10);
      const dl = (name) => ({ "Content-Disposition": `attachment; filename="${name}"` });
      if (p === "/admin" || p === "/admin/") return send(res, 200, fs.readFileSync(path.join(__dirname, "public", "admin.html")), "text/html; charset=utf-8");
      if (p === "/admin/report" || p === "/admin/report/") return send(res, 200, fs.readFileSync(path.join(__dirname, "public", "report.html")), "text/html; charset=utf-8");
      if (p === "/admin/api/data") return json(res, 200, { submissions: all, stats: stats(all) });
      if (p === "/admin/download/all.json") return send(res, 200, JSON.stringify(all, null, 2), "application/json; charset=utf-8", dl(`all-submissions-${day}.json`));
      if (p === "/admin/download/stats.json") return send(res, 200, JSON.stringify(stats(all), null, 2), "application/json; charset=utf-8", dl(`report-stats-${day}.json`));
      if (p === "/admin/download/all.csv") return send(res, 200, toCSV(all), "text/csv; charset=utf-8", dl(`all-submissions-${day}.csv`));
      if (p === "/admin/download/stats.csv") return send(res, 200, statsCSV(stats(all)), "text/csv; charset=utf-8", dl(`questions-report-${day}.csv`));
      if (p === "/admin/download/all.zip") {
        const st = stats(all);
        const files = [
          ...all.map(s => ({ name: `students/${s.id}.json`, data: JSON.stringify(s, null, 2) })),
          { name: "all-submissions.json", data: JSON.stringify(all, null, 2) },
          { name: "all-submissions.csv", data: toCSV(all) },
          { name: "report-stats.json", data: JSON.stringify(st, null, 2) },
          { name: "questions-report.csv", data: statsCSV(st) },
        ];
        return send(res, 200, makeZip(files), "application/zip", dl(`survey-data-${day}.zip`));
      }
      const m = p.match(/^\/admin\/download\/student\/([\w-]+)\.json$/);
      if (m) { const s = all.find(x => x.id === m[1]); if (!s) return json(res, 404, { error: "غير موجود" }); return send(res, 200, JSON.stringify(s, null, 2), "application/json; charset=utf-8", dl(`${s.id}.json`)); }
      const d = p.match(/^\/admin\/api\/delete\/([\w-]+)$/);
      if (d && req.method === "POST") { const f = path.join(SUB_DIR, `${d[1]}.json`); if (fs.existsSync(f)) fs.unlinkSync(f); for (const c of fs.readdirSync(CID_DIR)) { try { if (fs.readFileSync(path.join(CID_DIR, c), "utf8") === d[1]) fs.unlinkSync(path.join(CID_DIR, c)); } catch {} } return json(res, 200, { ok: true }); }
    }
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  } catch (e) { console.error(e); json(res, 500, { ok: false, error: "خطأ في الخادم" }); }
});

server.listen(PORT, () => console.log(`Server running on port ${PORT} — data in ${DATA_DIR}`));
