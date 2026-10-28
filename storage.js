// PostgreSQL storage module for motivation-survey
// Fallback to file system if DATABASE_URL is not set

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// File storage implementation (fallback)
class FileStorage {
  constructor(dataDir) {
    this.subDir = path.join(dataDir, "submissions");
    this.cidDir = path.join(dataDir, "client-ids");
    fs.mkdirSync(this.subDir, { recursive: true });
    fs.mkdirSync(this.cidDir, { recursive: true });
  }

  async save(data) {
    const now = new Date();
    const id = `${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`;
    const total = Object.keys(data.answers).reduce((a, q) => a + data.answers[q], 0);
    const record = {
      id,
      form_version: data.form_version || "motivation-scale-v1",
      submitted_at: now.toISOString(),
      ...data,
      total_score: total,
      mean_score: Number((total / 57).toFixed(3))
    };
    fs.writeFileSync(path.join(this.subDir, `${id}.json`), JSON.stringify(record, null, 2));
    if (data.client_id) fs.writeFileSync(path.join(this.cidDir, data.client_id), id);
    return { ok: true, id, duplicate: false };
  }

  async getById(id) {
    try {
      const file = path.join(this.subDir, `${id}.json`);
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  async listAll() {
    return fs.readdirSync(this.subDir)
      .filter(f => f.endsWith(".json"))
      .sort()
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(this.subDir, f), "utf8")); }
        catch { return null; }
      })
      .filter(Boolean);
  }

  async count() {
    return fs.readdirSync(this.subDir).filter(f => f.endsWith(".json")).length;
  }

  async delete(id) {
    const file = path.join(this.subDir, `${id}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    for (const c of fs.readdirSync(this.cidDir)) {
      try {
        if (fs.readFileSync(path.join(this.cidDir, c), "utf8") === id) fs.unlinkSync(path.join(this.cidDir, c));
      } catch {}
    }
    return { ok: true };
  }

  async cleanup() {}
}

// PostgreSQL storage implementation
class PostgresStorage {
  constructor(pool) {
    this.pool = pool;
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_submissions_created_at ON submissions(created_at);
    `);
  }

  async save(data) {
    const now = new Date();
    const id = `${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`;
    const total = Object.keys(data.answers).reduce((a, q) => a + data.answers[q], 0);
    const record = {
      id,
      form_version: data.form_version || "motivation-scale-v1",
      submitted_at: now.toISOString(),
      ...data,
      total_score: total,
      mean_score: Number((total / 57).toFixed(3))
    };

    try {
      await this.pool.query(
        `INSERT INTO submissions (id, data, created_at, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [id, record, now, now]
      );
      return { ok: true, id, duplicate: false };
    } catch (err) {
      console.error("Database save error:", err);
      return { ok: false, error: err.message };
    }
  }

  async getById(id) {
    try {
      const result = await this.pool.query(
        "SELECT data FROM submissions WHERE id = $1",
        [id]
      );
      return result.rows[0]?.data || null;
    } catch (err) {
      console.error("Database getById error:", err);
      return null;
    }
  }

  async listAll() {
    try {
      const result = await this.pool.query(
        "SELECT data FROM submissions ORDER BY created_at"
      );
      return result.rows.map(r => r.data);
    } catch (err) {
      console.error("Database listAll error:", err);
      return [];
    }
  }

  async count() {
    try {
      const result = await this.pool.query(
        "SELECT COUNT(*) FROM submissions"
      );
      return parseInt(result.rows[0].count) || 0;
    } catch (err) {
      console.error("Database count error:", err);
      return 0;
    }
  }

  async delete(id) {
    try {
      await this.pool.query(
        "DELETE FROM submissions WHERE id = $1",
        [id]
      );
      return { ok: true };
    } catch (err) {
      console.error("Database delete error:", err);
      return { ok: false, error: err.message };
    }
  }

  async cleanup() {
    await this.pool.end();
  }
}

// Main storage factory
let _storage = null;
let _usingPostgres = false;

async function ensureStorage() {
  if (_storage) return _storage;

  const { Pool } = require("pg");
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    try {
      const pool = new Pool({
        connectionString: databaseUrl,
        ssl: { rejectUnauthorized: false }
      });

      await pool.query("SELECT 1");

      const pgStorage = new PostgresStorage(pool);
      await pgStorage.init();
      _storage = pgStorage;
      _usingPostgres = true;
      console.log("Using PostgreSQL storage");
    } catch (err) {
      console.error("Failed to initialize PostgreSQL:", err.message);
      console.log("Falling back to file storage");
      _storage = new FileStorage(process.env.DATA_DIR || path.join(__dirname, "data"));
    }
  } else {
    _storage = new FileStorage(process.env.DATA_DIR || path.join(__dirname, "data"));
    console.log("Using file system storage (no DATABASE_URL)");
  }

  return _storage;
}

// Public API
async function save(data) {
  const storage = await ensureStorage();
  return storage.save(data);
}

async function getById(id) {
  const storage = await ensureStorage();
  return storage.getById(id);
}

async function listAll() {
  const storage = await ensureStorage();
  return storage.listAll();
}

async function count() {
  const storage = await ensureStorage();
  return storage.count();
}

// NOTE: "delete" is a reserved word in JavaScript and cannot be used as a
// standalone function name, so the public API wrapper is named `remove` and
// exported under the key "delete" to keep server.js's storage.delete() working.
async function remove(id) {
  const storage = await ensureStorage();
  return storage.delete(id);
}

async function cleanup() {
  const storage = await ensureStorage();
  return storage.cleanup();
}

module.exports = {
  save,
  getById,
  listAll,
  count,
  delete: remove,
  cleanup,
  // Internal
  _usingPostgres,
  _getStorage: ensureStorage
};