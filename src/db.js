const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH || path.join(__dirname, "..", "data", "app.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

function now() {
  return new Date().toISOString();
}

function hasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
}

function addColumn(table, definition) {
  const column = definition.trim().split(/\s+/)[0];
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sub2api_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      email TEXT NOT NULL,
      password TEXT NOT NULL,
      source_group_ids TEXT NOT NULL DEFAULT '[]',
      taken_group_ids TEXT NOT NULL DEFAULT '[]',
      move_to_taken_group INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_profile_assignments (
      user_id INTEGER NOT NULL,
      profile_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, profile_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (profile_id) REFERENCES sub2api_profiles(id)
    );

    CREATE TABLE IF NOT EXISTS sub2api_groups (
      profile_id INTEGER NOT NULL,
      remote_group_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      platform TEXT,
      status TEXT,
      raw_json TEXT NOT NULL,
      cached_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, remote_group_id),
      FOREIGN KEY (profile_id) REFERENCES sub2api_profiles(id)
    );

    CREATE TABLE IF NOT EXISTS remote_groups (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT,
      status TEXT,
      raw_json TEXT NOT NULL,
      cached_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS take_batches (
      id TEXT PRIMARY KEY,
      requested_count INTEGER NOT NULL,
      issued_count INTEGER NOT NULL,
      validate_requested INTEGER NOT NULL DEFAULT 0,
      validation_status TEXT,
      remote_move_status TEXT,
      export_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS take_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      remote_account_id INTEGER NOT NULL,
      account_name TEXT NOT NULL,
      platform TEXT,
      type TEXT,
      status TEXT,
      schedulable INTEGER,
      source_group_ids TEXT NOT NULL,
      target_group_ids TEXT NOT NULL,
      validation_status TEXT,
      validation_message TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES take_batches(id)
    );

    CREATE TABLE IF NOT EXISTS validation_runs (
      id TEXT PRIMARY KEY,
      requested_count INTEGER NOT NULL,
      checked_count INTEGER NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  addColumn("users", "display_name TEXT NOT NULL DEFAULT ''");
  addColumn("users", "role TEXT NOT NULL DEFAULT 'user'");
  addColumn("users", "enabled INTEGER NOT NULL DEFAULT 1");
  addColumn("users", "updated_at TEXT");

  addColumn("take_batches", "user_id INTEGER");
  addColumn("take_batches", "profile_id INTEGER");
  addColumn("take_batches", "profile_name TEXT");
  addColumn("take_batches", "restore_status TEXT");
  addColumn("take_batches", "restored_at TEXT");

  addColumn("take_records", "user_id INTEGER");
  addColumn("take_records", "profile_id INTEGER");
  addColumn("take_records", "profile_name TEXT");
  addColumn("take_records", "restore_status TEXT");
  addColumn("take_records", "restored_at TEXT");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_take_records_remote_account_id
      ON take_records(remote_account_id);
    CREATE INDEX IF NOT EXISTS idx_take_records_profile_id
      ON take_records(profile_id);
    CREATE INDEX IF NOT EXISTS idx_take_records_user_id
      ON take_records(user_id);
    CREATE INDEX IF NOT EXISTS idx_take_batches_profile_id
      ON take_batches(profile_id);
    CREATE INDEX IF NOT EXISTS idx_take_batches_user_id
      ON take_batches(user_id);
  `);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const actual = Buffer.from(crypto.scryptSync(password, salt, 64).toString("hex"), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), now());
}

function getSetting(key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function hasSetting(key) {
  return Boolean(db.prepare("SELECT 1 FROM settings WHERE key = ?").get(key));
}

function createUser({ username, password, displayName = "", role = "user", enabled = 1 }) {
  const { salt, hash } = hashPassword(password);
  return db.prepare(`
    INSERT INTO users (username, password_hash, salt, display_name, role, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(username, hash, salt, displayName, role, enabled ? 1 : 0, now(), now());
}

function ensureUser({ username, password, displayName = "", role = "user" }) {
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user) {
    createUser({ username, password, displayName, role, enabled: 1 });
    return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  }
  const patch = {};
  if (!user.role || user.role !== role && username === (process.env.APP_USERNAME || "admin")) patch.role = role;
  if (!user.display_name) patch.display_name = displayName;
  if (Object.keys(patch).length) {
    const fields = Object.keys(patch).map((key) => `${key} = @${key}`).join(", ");
    db.prepare(`UPDATE users SET ${fields}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...patch, updated_at: now(), id: user.id });
  }
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}

function seed() {
  const legacyDefaults = {
    sub2api_url: process.env.SUB2API_URL || "",
    sub2api_email: process.env.SUB2API_EMAIL || "",
    sub2api_password: process.env.SUB2API_PASSWORD || "",
    source_group_ids: [],
    taken_group_ids: [],
    move_to_taken_group: false
  };

  for (const [key, value] of Object.entries(legacyDefaults)) {
    if (!hasSetting(key)) setSetting(key, value);
  }

  if (!getSetting("app_secret", null)) {
    setSetting("app_secret", process.env.APP_SECRET || crypto.randomBytes(32).toString("hex"));
  }

  const admin = ensureUser({
    username: process.env.APP_USERNAME || "admin",
    password: process.env.APP_PASSWORD || "admin123456",
    displayName: "管理员",
    role: "admin"
  });

  const frontUser = ensureUser({
    username: process.env.FRONT_USERNAME || "user",
    password: process.env.FRONT_PASSWORD || "user123456",
    displayName: "前台用户",
    role: "user"
  });

  let profile = db.prepare("SELECT * FROM sub2api_profiles ORDER BY id LIMIT 1").get();
  if (!profile) {
    const createdAt = now();
    const result = db.prepare(`
      INSERT INTO sub2api_profiles (
        name, base_url, email, password, source_group_ids, taken_group_ids,
        move_to_taken_group, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "默认 Sub2API",
      legacyDefaults.sub2api_url,
      legacyDefaults.sub2api_email,
      legacyDefaults.sub2api_password,
      JSON.stringify(legacyDefaults.source_group_ids),
      JSON.stringify(legacyDefaults.taken_group_ids),
      legacyDefaults.move_to_taken_group ? 1 : 0,
      1,
      createdAt,
      createdAt
    );
    profile = db.prepare("SELECT * FROM sub2api_profiles WHERE id = ?").get(result.lastInsertRowid);
  }

  const assign = db.prepare(`
    INSERT OR IGNORE INTO user_profile_assignments (user_id, profile_id, created_at)
    VALUES (?, ?, ?)
  `);
  assign.run(admin.id, profile.id, now());
  assign.run(frontUser.id, profile.id, now());
}

migrate();
seed();

module.exports = {
  db,
  now,
  getSetting,
  setSetting,
  hashPassword,
  verifyPassword,
  createUser
};
