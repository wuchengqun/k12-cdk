require("dotenv").config({ quiet: true });

const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const {
  db,
  getSetting,
  setSetting,
  verifyPassword,
  hashPassword,
  createUser,
  now
} = require("./db");
const { Sub2ApiClient, Sub2ApiError } = require("./sub2apiClient");
const { Pan123Client, Pan123Error } = require("./pan123Client");
const { loginPan123ByPlaywright, publicUserInfo } = require("./pan123PlaywrightLogin");

const app = express();
const port = Number(process.env.PORT || 8978);
const publicDir = path.join(__dirname, "..", "public");

app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
app.use(express.static(publicDir, {
  etag: false,
  lastModified: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store");
      return;
    }
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
  }
}));

function parseJson(value, fallback = []) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

function stringifyIds(value) {
  return JSON.stringify(parseIds(value));
}

function parseIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
}

function publicProfile(profile, includeGroups = false) {
  const data = {
    id: profile.id,
    name: profile.name,
    base_url: profile.base_url,
    email: profile.email,
    password: profile.password ? "********" : "",
    source_group_ids: parseJson(profile.source_group_ids, []),
    taken_group_ids: parseJson(profile.taken_group_ids, []),
    move_to_taken_group: Boolean(profile.move_to_taken_group),
    enabled: Boolean(profile.enabled),
    created_at: profile.created_at,
    updated_at: profile.updated_at
  };
  if (includeGroups) data.groups = groupsForProfile(profile.id);
  return data;
}

function profileForClient(profile) {
  return {
    id: profile.id,
    name: profile.name,
    base_url: profile.base_url,
    email: profile.email,
    password: profile.password,
    source_group_ids: parseJson(profile.source_group_ids, []),
    taken_group_ids: parseJson(profile.taken_group_ids, []),
    move_to_taken_group: Boolean(profile.move_to_taken_group),
    enabled: Boolean(profile.enabled)
  };
}

function getProfile(id) {
  return db.prepare("SELECT * FROM sub2api_profiles WHERE id = ?").get(Number(id));
}

function getEnabledProfile(id) {
  const profile = getProfile(id);
  if (!profile || !profile.enabled) return null;
  return profile;
}

function getAssignedProfiles(user) {
  if (user.role === "admin") {
    return db.prepare("SELECT * FROM sub2api_profiles WHERE enabled = 1 ORDER BY id").all();
  }
  return db.prepare(`
    SELECT p.*
    FROM sub2api_profiles p
    JOIN user_profile_assignments a ON a.profile_id = p.id
    WHERE a.user_id = ? AND p.enabled = 1
    ORDER BY p.id
  `).all(user.uid);
}

function assertAssignedProfile(req, profileId) {
  const profile = getEnabledProfile(profileId);
  if (!profile) return null;
  if (req.user.role === "admin") return profile;
  const row = db.prepare(`
    SELECT 1 FROM user_profile_assignments
    WHERE user_id = ? AND profile_id = ?
  `).get(req.user.uid, profile.id);
  return row ? profile : null;
}

function clientForProfile(profile) {
  return new Sub2ApiClient(profileForClient(profile));
}

function appSecret() {
  return getSetting("app_secret", process.env.APP_SECRET || "dev-secret");
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signSession(payload) {
  const body = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", appSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readSession(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", appSecret()).update(body).digest("base64url");
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

function requireAuth(req, res, next) {
  const session = readSession(req.cookies.session);
  if (!session) return res.status(401).json({ error: "请先登录" });
  const user = db.prepare(`
    SELECT id, username, display_name, role, enabled
    FROM users WHERE id = ?
  `).get(session.uid);
  if (!user || !user.enabled) return res.status(401).json({ error: "账号不可用" });
  req.user = {
    uid: user.id,
    username: user.username,
    display_name: user.display_name || user.username,
    role: user.role || "user"
  };
  return next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "需要后台管理员权限" });
  return next();
}

function handleError(res, error) {
  console.error(error);
  if (error instanceof Pan123Error) {
    return res.status(error.statusCode || 502).json({
      error: error.message,
      detail: error.detail
    });
  }
  if (error.statusCode) {
    return res.status(error.statusCode).json({ error: error.message || "请求失败" });
  }
  if (error instanceof Sub2ApiError) {
    return res.status(502).json({
      error: error.message,
      status: error.status,
      detail: error.detail
    });
  }
  return res.status(500).json({ error: error.message || "服务器错误" });
}

function groupIdsOf(account) {
  if (Array.isArray(account.group_ids)) return account.group_ids;
  if (Array.isArray(account.groups)) return account.groups.map((group) => group.id);
  return [];
}

function sourceGroupIdsForRecord(account, configuredGroupIds) {
  const accountGroupIds = parseIds(groupIdsOf(account));
  if (accountGroupIds.length) return accountGroupIds;
  const matchedGroupIds = parseIds(account._source_group_ids || []);
  if (matchedGroupIds.length) return matchedGroupIds;
  return parseIds(configuredGroupIds);
}

function isUsableAccount(account) {
  return account
    && account.status === "active"
    && account.schedulable !== false
    && !account.temp_unschedulable_until
    && !account.error_message;
}

function parseAccountTestResult(raw) {
  const events = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      events.push({ type: "raw", text: payload });
    }
  }
  const errorEvent = events.find((event) => event.type === "error");
  if (errorEvent) return { ok: false, error: errorEvent.error || errorEvent.message || "账号测试失败" };
  const completeEvent = events.find((event) => event.type === "test_complete");
  if (completeEvent) return { ok: completeEvent.success === true, error: completeEvent.success === true ? "" : "账号测试未通过" };
  return { ok: false, error: "账号测试没有返回完成事件" };
}

function accountTestSummary(results) {
  const total = results.length;
  const failedResults = results.filter((result) => !result.ok);
  const success = total - failedResults.length;
  const failed = failedResults.length;
  const allIssues = failedResults.map((result) => `${result.account.id}: ${result.error || "账号测试失败"}`);
  const message = [
    `批量验活完成：成功 ${success}，失败 ${failed}，总计 ${total}`,
    allIssues.length ? `失败明细：${allIssues.slice(0, 3).join("；")}${allIssues.length > 3 ? "；..." : ""}` : ""
  ].filter(Boolean).join("。");
  return {
    status: failed > 0 ? (success > 0 ? "partial_failed" : "failed") : "ok",
    message,
    total,
    success,
    failed,
    issues: allIssues,
    invalidAccounts: failedResults.map((result) => result.account)
  };
}

async function testRemoteAccounts(remote, accounts) {
  const results = [];
  const chunkSize = 20;
  for (let index = 0; index < accounts.length; index += chunkSize) {
    const chunk = accounts.slice(index, index + chunkSize);
    results.push(...await Promise.all(chunk.map(async (account) => {
      try {
        const raw = await remote.testAccount(account.id);
        const parsed = parseAccountTestResult(raw);
        return { account, ok: parsed.ok, error: parsed.error };
      } catch (error) {
        return { account, ok: false, error: error.message || "账号测试请求失败" };
      }
    })));
  }
  return results;
}

async function validateRemoteAccounts(remote, accounts) {
  if (!accounts.length) return accountTestSummary([]);
  return accountTestSummary(await testRemoteAccounts(remote, accounts));
}

function getIssuedAccountIds(profileId) {
  return new Set(
    db.prepare(`
      SELECT DISTINCT remote_account_id
      FROM take_records
      WHERE profile_id = ? AND restore_status IS NULL
    `).all(profileId).map((row) => Number(row.remote_account_id))
  );
}

function groupsForProfile(profileId) {
  return db.prepare(`
    SELECT profile_id, remote_group_id AS id, name, platform, status, cached_at
    FROM sub2api_groups
    WHERE profile_id = ?
    ORDER BY platform, name
  `).all(profileId);
}

function saveGroups(profileId, groups) {
  const insert = db.prepare(`
    INSERT INTO sub2api_groups (profile_id, remote_group_id, name, platform, status, raw_json, cached_at)
    VALUES (@profile_id, @remote_group_id, @name, @platform, @status, @raw_json, @cached_at)
    ON CONFLICT(profile_id, remote_group_id) DO UPDATE SET
      name = excluded.name,
      platform = excluded.platform,
      status = excluded.status,
      raw_json = excluded.raw_json,
      cached_at = excluded.cached_at
  `);
  const tx = db.transaction((items) => {
    for (const group of items) {
      insert.run({
        profile_id: profileId,
        remote_group_id: group.id,
        name: group.name || `Group ${group.id}`,
        platform: group.platform || "",
        status: group.status || "",
        raw_json: JSON.stringify(group),
        cached_at: now()
      });
    }
  });
  tx(groups);
}

async function candidateAccounts(profile, limit) {
  const config = profileForClient(profile);
  if (!config.source_group_ids.length) {
    const error = new Error("当前 Sub2API 账号没有配置取号分组，不能取号");
    error.statusCode = 400;
    throw error;
  }
  const issued = getIssuedAccountIds(profile.id);
  return (await clientForProfile(profile).listAccountsFromGroups(config.source_group_ids))
    .filter(isUsableAccount)
    .filter((account) => !issued.has(Number(account.id)))
    .slice(0, limit);
}

async function remainingAvailability(profile) {
  const config = profileForClient(profile);
  if (!config.source_group_ids.length) {
    const error = new Error("当前 Sub2API 账号没有配置取号分组，不能查看剩余账号");
    error.statusCode = 400;
    throw error;
  }
  const issued = getIssuedAccountIds(profile.id);
  const remote = clientForProfile(profile);
  const groupNames = new Map(groupsForProfile(profile.id).map((group) => [Number(group.id), group.name]));
  const unique = new Map();
  const groups = [];
  for (const groupId of config.source_group_ids) {
    const accounts = (await remote.listAccountsFromGroups([groupId]))
      .filter(isUsableAccount)
      .filter((account) => !issued.has(Number(account.id)));
    for (const account of accounts) unique.set(Number(account.id), account);
    groups.push({
      id: groupId,
      name: groupNames.get(Number(groupId)) || `Group ${groupId}`,
      remaining_count: accounts.length
    });
  }
  return {
    profile: publicProfile(profile),
    total_remaining: unique.size,
    groups
  };
}

function canAccessBatch(req, batch) {
  return req.user.role === "admin" || Number(batch.user_id) === Number(req.user.uid);
}

async function restoreMovedBatch(batch) {
  if (batch.restore_status) {
    const error = new Error("这个批次已经挪回过，无需重复操作");
    error.statusCode = 400;
    throw error;
  }
  if (!(batch.remote_move_status || "").includes("已提交移动")) {
    const error = new Error("这个批次没有移动到取号后分组，无需挪回");
    error.statusCode = 400;
    throw error;
  }
  const profile = getProfile(batch.profile_id);
  if (!profile) {
    const error = new Error("批次对应的 Sub2API 账号不存在");
    error.statusCode = 404;
    throw error;
  }
  const records = db.prepare(`
    SELECT id, remote_account_id, source_group_ids, target_group_ids
    FROM take_records
    WHERE batch_id = ?
    ORDER BY id
  `).all(batch.id);
  if (!records.length) {
    const error = new Error("这个批次没有账号记录，不能挪回");
    error.statusCode = 400;
    throw error;
  }
  const movedRecords = records.filter((record) => parseJson(record.target_group_ids, []).length > 0);
  if (!movedRecords.length) {
    const error = new Error("这个批次没有移动到取号后分组，无需挪回");
    error.statusCode = 400;
    throw error;
  }
  const groups = new Map();
  for (const record of movedRecords) {
    const sourceGroupIds = parseJson(record.source_group_ids, []);
    if (!sourceGroupIds.length) continue;
    const key = JSON.stringify(sourceGroupIds);
    if (!groups.has(key)) groups.set(key, { groupIds: sourceGroupIds, accountIds: [] });
    groups.get(key).accountIds.push(record.remote_account_id);
  }
  if (!groups.size) {
    const error = new Error("原取号分组记录为空，不能自动挪回");
    error.statusCode = 400;
    throw error;
  }
  const remote = clientForProfile(profile);
  let restoredCount = 0;
  const restoredAccountIds = [];
  for (const item of groups.values()) {
    await remote.moveAccounts(item.accountIds, item.groupIds);
    restoredCount += item.accountIds.length;
    restoredAccountIds.push(...item.accountIds);
  }
  let restoreStatus = "已挪回原取号分组，已验活";
  let restoreValidationStatus = "ok";
  let restoreValidationMessage = "挪回后批量验活已完成";
  try {
    await remote.batchRefresh([...new Set(restoredAccountIds)]);
  } catch (error) {
    restoreStatus = "已挪回原取号分组，验活失败";
    restoreValidationStatus = "failed";
    restoreValidationMessage = error.message || "挪回后批量验活失败";
    console.error(error);
  }
  const restoredAt = now();
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE take_batches
      SET restore_status = ?, restored_at = ?
      WHERE id = ?
    `).run(restoreStatus, restoredAt, batch.id);
    db.prepare(`
      UPDATE take_records
      SET restore_status = ?, restored_at = ?
      WHERE batch_id = ?
    `).run(restoreStatus, restoredAt, batch.id);
  });
  tx();
  return {
    restored_count: restoredCount,
    restored_at: restoredAt,
    validation_status: restoreValidationStatus,
    validation_message: restoreValidationMessage
  };
}

function userPayload(user) {
  return {
    id: user.uid || user.id,
    username: user.username,
    display_name: user.display_name || user.displayName || user.username,
    role: user.role || "user"
  };
}

function effectiveIssuedSql(alias = "b") {
  const restoredCount = `(SELECT COUNT(*) FROM take_records r WHERE r.batch_id = ${alias}.id AND r.restore_status IS NOT NULL)`;
  return `CASE
    WHEN ${alias}.id IS NULL THEN 0
    WHEN ${alias}.issued_count > ${restoredCount} THEN ${alias}.issued_count - ${restoredCount}
    ELSE 0
  END`;
}

function frontStats(user) {
  const effectiveIssued = effectiveIssuedSql("b");
  const profiles = getAssignedProfiles(user).map((profile) => {
    const row = db.prepare(`
      SELECT COALESCE(SUM(${effectiveIssued}), 0) AS taken_count, COUNT(b.id) AS batch_count
      FROM take_batches b
      WHERE b.user_id = ? AND b.profile_id = ?
    `).get(user.uid, profile.id);
    return {
      ...publicProfile(profile),
      taken_count: Number(row.taken_count || 0),
      batch_count: Number(row.batch_count || 0)
    };
  });
  const total = db.prepare(`
    SELECT COALESCE(SUM(${effectiveIssued}), 0) AS taken_count, COUNT(b.id) AS batch_count
    FROM take_batches b
    WHERE b.user_id = ?
  `).get(user.uid);
  const today = new Date().toISOString().slice(0, 10);
  const todayTotal = db.prepare(`
    SELECT COALESCE(SUM(${effectiveIssued}), 0) AS taken_count
    FROM take_batches b
    WHERE b.user_id = ? AND substr(b.created_at, 1, 10) = ?
  `).get(user.uid, today);
  const dailyStats = db.prepare(`
    SELECT substr(b.created_at, 1, 10) AS day,
           COALESCE(SUM(${effectiveIssued}), 0) AS taken_count,
           COUNT(*) AS batch_count
    FROM take_batches b
    WHERE b.user_id = ?
    GROUP BY day
    ORDER BY day DESC
    LIMIT 30
  `).all(user.uid).map((row) => ({
    day: row.day,
    taken_count: Number(row.taken_count || 0),
    batch_count: Number(row.batch_count || 0)
  }));
  const recent = db.prepare(`
    SELECT id, profile_id, profile_name, requested_count, issued_count,
           validation_status, remote_move_status, restore_status, restored_at, delivery_method,
           share_status, share_url, share_pwd, share_error, shared_at, created_at
    FROM take_batches
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(user.uid);
  return {
    total_taken: Number(total.taken_count || 0),
    today_taken: Number(todayTotal.taken_count || 0),
    total_batches: Number(total.batch_count || 0),
    daily_stats: dailyStats,
    profiles,
    recent
  };
}

function adminOverview() {
  const effectiveIssued = effectiveIssuedSql("b");
  const today = new Date().toISOString().slice(0, 10);
  const totalUsers = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'user'").get().count;
  const totalProfiles = db.prepare("SELECT COUNT(*) AS count FROM sub2api_profiles").get().count;
  const totalTaken = db.prepare(`
    SELECT COALESCE(SUM(${effectiveIssued}), 0) AS count
    FROM take_batches b
  `).get().count;
  const totalBatches = db.prepare("SELECT COUNT(*) AS count FROM take_batches").get().count;
  const todayTaken = db.prepare(`
    SELECT COALESCE(SUM(${effectiveIssued}), 0) AS count
    FROM take_batches b
    WHERE substr(b.created_at, 1, 10) = ?
  `).get(today).count;
  const dailyStats = db.prepare(`
    SELECT substr(b.created_at, 1, 10) AS day,
           COALESCE(SUM(${effectiveIssued}), 0) AS taken_count,
           COUNT(*) AS batch_count
    FROM take_batches b
    GROUP BY day
    ORDER BY day DESC
    LIMIT 30
  `).all().map((row) => ({
    day: row.day,
    taken_count: Number(row.taken_count || 0),
    batch_count: Number(row.batch_count || 0)
  }));
  const perProfile = db.prepare(`
    SELECT
      p.id,
      p.name,
      p.email,
      COALESCE(SUM(${effectiveIssued}), 0) AS taken_count,
      COUNT(b.id) AS batch_count
    FROM sub2api_profiles p
    LEFT JOIN take_batches b ON b.profile_id = p.id
    GROUP BY p.id
    ORDER BY p.id
  `).all();
  const perUser = db.prepare(`
    SELECT
      u.id,
      u.username,
      u.display_name,
      COALESCE(SUM(${effectiveIssued}), 0) AS taken_count,
      COUNT(b.id) AS batch_count
    FROM users u
    LEFT JOIN take_batches b ON b.user_id = u.id
    WHERE u.role = 'user'
    GROUP BY u.id
    ORDER BY taken_count DESC, u.id
  `).all();
  return {
    total_users: Number(totalUsers || 0),
    total_profiles: Number(totalProfiles || 0),
    total_taken: Number(totalTaken || 0),
    today_taken: Number(todayTaken || 0),
    total_batches: Number(totalBatches || 0),
    daily_stats: dailyStats,
    per_profile: perProfile.map((row) => ({
      ...row,
      taken_count: Number(row.taken_count || 0),
      batch_count: Number(row.batch_count || 0)
    })),
    per_user: perUser.map((row) => ({
      ...row,
      taken_count: Number(row.taken_count || 0),
      batch_count: Number(row.batch_count || 0)
    }))
  };
}

function userAssignments(userId) {
  return db.prepare(`
    SELECT profile_id FROM user_profile_assignments
    WHERE user_id = ?
    ORDER BY profile_id
  `).all(userId).map((row) => row.profile_id);
}

function replaceAssignments(userId, profileIds) {
  const ids = parseIds(profileIds);
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM user_profile_assignments WHERE user_id = ?").run(userId);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO user_profile_assignments (user_id, profile_id, created_at)
      VALUES (?, ?, ?)
    `);
    for (const profileId of ids) {
      if (getProfile(profileId)) insert.run(userId, profileId, now());
    }
  });
  tx();
}

function maskText(value, head = 3, tail = 4) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= head + tail) return "*".repeat(text.length);
  return `${text.slice(0, head)}${"*".repeat(Math.max(4, text.length - head - tail))}${text.slice(-tail)}`;
}

function pan123StoredAuth() {
  const saved = getSetting("pan123_auth", {}) || {};
  return {
    token: String(saved.token || "").trim(),
    cookie: String(saved.cookie || "").trim(),
    loginUuid: String(saved.loginUuid || "").trim(),
    updatedAt: saved.updatedAt || "",
    loginMethod: saved.loginMethod || "",
    userInfo: saved.userInfo || null
  };
}

function boolFromValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function pan123StoredConfig() {
  const saved = getSetting("pan123_config", {}) || {};
  const envMethod = String(process.env.PAN123_LOGIN_METHOD || "").trim().toLowerCase();
  const savedMethod = String(saved.login_method || saved.loginMethod || "").trim().toLowerCase();
  const loginMethod = ["api", "playwright"].includes(savedMethod)
    ? savedMethod
    : ["api", "playwright"].includes(envMethod) ? envMethod : "api";
  const timeout = Number(saved.playwright_timeout_ms || saved.playwrightTimeoutMs || process.env.PAN123_PLAYWRIGHT_TIMEOUT_MS || 90000);
  return {
    login_method: loginMethod,
    playwright_headless: saved.playwright_headless === undefined && saved.playwrightHeadless === undefined
      ? boolFromValue(process.env.PAN123_PLAYWRIGHT_HEADLESS, process.env.NODE_ENV === "production")
      : Boolean(saved.playwright_headless ?? saved.playwrightHeadless),
    playwright_timeout_ms: Number.isFinite(timeout) && timeout > 0 ? Math.min(Math.max(timeout, 10000), 300000) : 90000
  };
}

function pan123Credentials() {
  const saved = getSetting("pan123_config", {}) || {};
  return {
    account: String(saved.account || process.env.PAN123_ACCOUNT || "").trim(),
    password: String(saved.password || process.env.PAN123_PASSWORD || "")
  };
}

function pan123PublicConfig() {
  const credentials = pan123Credentials();
  return {
    ...pan123StoredConfig(),
    account: credentials.account,
    has_password: Boolean(credentials.password)
  };
}

function savePan123Config(body = {}) {
  const current = pan123StoredConfig();
  const saved = getSetting("pan123_config", {}) || {};
  const requestedMethod = String(body.login_method || body.loginMethod || "").trim().toLowerCase();
  const hasHeadless = Object.prototype.hasOwnProperty.call(body, "playwright_headless")
    || Object.prototype.hasOwnProperty.call(body, "playwrightHeadless");
  const hasAccount = Object.prototype.hasOwnProperty.call(body, "account");
  const hasPassword = Object.prototype.hasOwnProperty.call(body, "password") && String(body.password || "") !== "";
  const requestedHeadless = Object.prototype.hasOwnProperty.call(body, "playwright_headless")
    ? body.playwright_headless
    : body.playwrightHeadless;
  const loginMethod = ["api", "playwright"].includes(requestedMethod)
    ? requestedMethod
    : current.login_method;
  const timeout = Number(body.playwright_timeout_ms || body.playwrightTimeoutMs || current.playwright_timeout_ms);
  const config = {
    login_method: loginMethod,
    playwright_headless: hasHeadless ? boolFromValue(requestedHeadless, current.playwright_headless) : current.playwright_headless,
    playwright_timeout_ms: Number.isFinite(timeout) && timeout > 0 ? Math.min(Math.max(timeout, 10000), 300000) : current.playwright_timeout_ms
  };
  if (hasAccount || saved.account) config.account = hasAccount ? String(body.account || "").trim() : String(saved.account || "").trim();
  if (hasPassword || saved.password) config.password = hasPassword ? String(body.password || "") : String(saved.password || "");
  setSetting("pan123_config", config);
  return config;
}

function pan123ClientConfig(extra = {}) {
  const saved = pan123EffectiveAuth();
  const credentials = pan123Credentials();
  return {
    account: credentials.account,
    password: credentials.password,
    token: saved.token,
    cookie: saved.cookie,
    loginUuid: saved.loginUuid,
    ...extra
  };
}

function pan123EffectiveAuth() {
  const saved = pan123StoredAuth();
  return {
    token: saved.token || String(process.env.PAN123_TOKEN || "").trim(),
    cookie: saved.cookie || String(process.env.PAN123_COOKIE || "").trim(),
    loginUuid: saved.loginUuid || String(process.env.PAN123_LOGIN_UUID || "").trim(),
    updatedAt: saved.updatedAt,
    loginMethod: saved.loginMethod,
    userInfo: saved.userInfo
  };
}

function pan123PublicStatus() {
  const saved = pan123EffectiveAuth();
  const credentials = pan123Credentials();
  return {
    account: maskText(credentials.account),
    configured: Boolean(credentials.account && credentials.password),
    logged_in: Boolean(saved.token || saved.cookie),
    has_token: Boolean(saved.token),
    has_cookie: Boolean(saved.cookie),
    updated_at: saved.updatedAt,
    login_method: saved.loginMethod || "",
    user: publicUserInfo(saved.userInfo),
    config: pan123PublicConfig()
  };
}

function savePan123Auth({ token = "", cookie = "", loginUuid = "", userInfo = null, loginMethod = "" }) {
  const auth = {
    token,
    cookie,
    loginUuid,
    userInfo,
    loginMethod,
    updatedAt: now()
  };
  setSetting("pan123_auth", auth);
  return pan123PublicStatus();
}

async function loginPan123WithApi() {
  const client = new Pan123Client(pan123ClientConfig({
    token: "",
    cookie: "",
    loginUuid: process.env.PAN123_LOGIN_UUID || ""
  }));
  const token = await client.login();
  const authedClient = new Pan123Client({
    token: token || "",
    cookie: token ? "" : client.cookie,
    loginUuid: client.loginUuid
  });
  const userInfo = await authedClient.userInfo();
  return savePan123Auth({
    token: token || "",
    cookie: token ? "" : client.cookie,
    loginUuid: client.loginUuid,
    userInfo,
    loginMethod: "api"
  });
}

async function loginPan123WithPlaywright() {
  const config = pan123StoredConfig();
  const credentials = pan123Credentials();
  const result = await loginPan123ByPlaywright({
    account: credentials.account,
    password: credentials.password,
    headless: config.playwright_headless,
    timeoutMs: config.playwright_timeout_ms
  });
  return savePan123Auth({
    token: result.token || "",
    cookie: "",
    loginUuid: result.loginUuid || "",
    userInfo: result.userInfo || null,
    loginMethod: "playwright"
  });
}

async function loginPan123WithConfiguredMethod(method = "") {
  const targetMethod = ["api", "playwright"].includes(String(method).trim().toLowerCase())
    ? String(method).trim().toLowerCase()
    : pan123StoredConfig().login_method;
  return targetMethod === "playwright" ? loginPan123WithPlaywright() : loginPan123WithApi();
}

function shareFileName(batch) {
  const stamp = new Date(batch.created_at || Date.now()).toISOString().replace(/\D/g, "").slice(0, 14);
  return `sub2api-accounts-${stamp}-${String(batch.id).slice(0, 8)}.json`;
}

function publicShare(row) {
  if (!row) return null;
  return {
    status: row.share_status || "not_requested",
    url: row.share_url || "",
    pwd: row.share_pwd || "",
    file_id: row.share_file_id || null,
    error: row.share_error || "",
    shared_at: row.shared_at || ""
  };
}

function updateBatchShare(batchId, patch) {
  db.prepare(`
    UPDATE take_batches
    SET share_status = @share_status,
        share_url = @share_url,
        share_pwd = @share_pwd,
        share_file_id = @share_file_id,
        share_error = @share_error,
        shared_at = @shared_at
    WHERE id = @id
  `).run({
    id: batchId,
    share_status: patch.share_status || null,
    share_url: patch.share_url || null,
    share_pwd: patch.share_pwd || null,
    share_file_id: patch.share_file_id || null,
    share_error: patch.share_error || null,
    shared_at: patch.shared_at || null
  });
}

async function shareBatchToPan(batch) {
  if (!batch.export_json) {
    const error = new Error("这个批次没有可分享的 JSON 内容");
    error.statusCode = 400;
    throw error;
  }
  let auth = pan123EffectiveAuth();
  if (!auth.token && !auth.cookie) {
    const credentials = pan123Credentials();
    if (!credentials.account || !credentials.password) {
      const error = new Error("123云盘账号或密码未配置，请检查配置文件里的 PAN123_ACCOUNT / PAN123_PASSWORD");
      error.statusCode = 400;
      throw error;
    }
    await loginPan123WithConfiguredMethod();
    auth = pan123EffectiveAuth();
    if (!auth.token && !auth.cookie) {
      const error = new Error("123云盘登录成功后没有拿到可用于分享的凭证，请到后台 123云盘 页面重新登录");
      error.statusCode = 400;
      throw error;
    }
  }
  updateBatchShare(batch.id, {
    share_status: "pending",
    share_url: batch.share_url,
    share_pwd: batch.share_pwd,
    share_file_id: batch.share_file_id,
    share_error: null,
    shared_at: batch.shared_at
  });
  const fileName = shareFileName(batch);
  try {
    const result = await new Pan123Client(pan123ClientConfig()).uploadAndShare({
      fileName,
      content: batch.export_json
    });
    const sharedAt = now();
    updateBatchShare(batch.id, {
      share_status: "ok",
      share_url: result.url,
      share_pwd: result.pwd,
      share_file_id: result.fileId,
      share_error: null,
      shared_at: sharedAt
    });
    return {
      status: "ok",
      url: result.url,
      pwd: result.pwd,
      file_id: result.fileId,
      message: result.message,
      shared_at: sharedAt
    };
  } catch (error) {
    updateBatchShare(batch.id, {
      share_status: "failed",
      share_url: batch.share_url,
      share_pwd: batch.share_pwd,
      share_file_id: batch.share_file_id,
      share_error: error.message,
      shared_at: batch.shared_at
    });
    throw error;
  }
}

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username || "");
  if (!user || !user.enabled || !verifyPassword(password || "", user.salt, user.password_hash)) {
    return res.status(401).json({ error: "账号或密码错误" });
  }
  const token = signSession({
    uid: user.id,
    username: user.username,
    role: user.role,
    exp: Date.now() + 12 * 60 * 60 * 1000
  });
  res.cookie("session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 12 * 60 * 60 * 1000
  });
  res.json({ ok: true, user: userPayload(user) });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("session");
  res.json({ ok: true });
});

app.get("/api/session", requireAuth, (req, res) => {
  res.json({ user: userPayload(req.user) });
});

app.get("/api/front/dashboard", requireAuth, (req, res) => {
  res.json(frontStats(req.user));
});

app.get("/api/front/candidates", requireAuth, async (req, res) => {
  try {
    const profile = assertAssignedProfile(req, req.query.profile_id);
    if (!profile) return res.status(403).json({ error: "没有可用的 Sub2API 账号分配" });
    const limit = Math.max(1, Math.min(Number(req.query.limit || 50), 500));
    const accounts = (await candidateAccounts(profile, limit)).map((account) => ({
      id: account.id,
      name: account.name,
      platform: account.platform,
      type: account.type,
      status: account.status,
      schedulable: account.schedulable,
      group_ids: groupIdsOf(account)
    }));
    res.json({ accounts });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/front/availability", requireAuth, async (req, res) => {
  try {
    const profile = assertAssignedProfile(req, req.query.profile_id);
    if (!profile) return res.status(403).json({ error: "没有可用的 Sub2API 账号分配" });
    res.json(await remainingAvailability(profile));
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/front/validate", requireAuth, async (req, res) => {
  try {
    const requested = Math.max(1, Math.min(Number(req.body.count || 20), 500));
    const profile = assertAssignedProfile(req, req.body.profile_id);
    if (!profile) return res.status(403).json({ error: "没有可用的 Sub2API 账号分配" });
    const accounts = await candidateAccounts(profile, requested);
    const ids = accounts.map((account) => account.id);
    let status = "skipped";
    let message = "没有可验活账号";
    let summary = null;
    if (ids.length) {
      summary = await validateRemoteAccounts(clientForProfile(profile), accounts);
      status = summary.status;
      message = summary.message;
    }
    const runId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO validation_runs (id, requested_count, checked_count, status, message, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(runId, requested, ids.length, status, message, req.user.username, now());
    res.json({
      id: runId,
      profile: publicProfile(profile),
      status,
      message,
      checked_count: ids.length,
      success_count: summary?.success || 0,
      failed_count: summary?.failed || 0,
      accounts: accounts.map((account) => ({
        id: account.id,
        name: account.name,
        platform: account.platform,
        type: account.type,
        group_ids: groupIdsOf(account)
      }))
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/front/take", requireAuth, async (req, res) => {
  try {
    const requested = Math.max(1, Math.min(Number(req.body.count || 1), 500));
    const validate = req.body.validate !== false;
    const delivery = req.body.delivery === "kanwang_share" ? "kanwang_share" : "download";
    const profile = assertAssignedProfile(req, req.body.profile_id);
    if (!profile) return res.status(403).json({ error: "没有可用的 Sub2API 账号分配" });
    const config = profileForClient(profile);
    const remote = clientForProfile(profile);
    const selected = await candidateAccounts(profile, requested);
    const ids = selected.map((account) => account.id);
    if (!ids.length) {
      return res.status(400).json({ error: "当前取号分组没有可提取账号，已停止取号，不会生成下载文件" });
    }

    let validationStatus = validate ? "skipped" : "disabled";
    let validationMessage = validate ? "没有可验活账号" : "未启用验活";
    if (validate && ids.length) {
      const summary = await validateRemoteAccounts(remote, selected);
      validationStatus = summary.status;
      validationMessage = summary.message;
      if (summary.failed > 0) {
        const error = new Error(`取号前批量验活失败，已停止取号。${summary.message}`);
        error.statusCode = 400;
        throw error;
      }
    }

    let moveStatus = "未移动";
    let movedToGroupIds = [];
    if (config.move_to_taken_group && ids.length && config.taken_group_ids.length) {
      await remote.moveAccounts(ids, config.taken_group_ids);
      moveStatus = "已提交移动到已取号分组";
      movedToGroupIds = config.taken_group_ids;
    }

    const exportJson = ids.length ? await remote.exportAccounts(ids) : {
      exported_at: now(),
      proxies: [],
      accounts: []
    };

    const batchId = crypto.randomUUID();
    const createdAt = now();
    const insertBatch = db.prepare(`
      INSERT INTO take_batches (
        id, requested_count, issued_count, validate_requested, validation_status,
        remote_move_status, export_json, created_by, created_at,
        user_id, profile_id, profile_name, delivery_method, share_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRecord = db.prepare(`
      INSERT INTO take_records (
        batch_id, remote_account_id, account_name, platform, type, status, schedulable,
        source_group_ids, target_group_ids, validation_status, validation_message, created_at,
        user_id, profile_id, profile_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
      insertBatch.run(
        batchId,
        requested,
        selected.length,
        validate ? 1 : 0,
        validationStatus,
        moveStatus,
        JSON.stringify(exportJson, null, 2),
        req.user.username,
        createdAt,
        req.user.uid,
        profile.id,
        profile.name,
        delivery,
        delivery === "kanwang_share" ? "pending" : "not_requested"
      );
      for (const account of selected) {
        insertRecord.run(
          batchId,
          account.id,
          account.name,
          account.platform || "",
          account.type || "",
          account.status || "",
          account.schedulable === false ? 0 : 1,
          JSON.stringify(sourceGroupIdsForRecord(account, config.source_group_ids)),
          JSON.stringify(movedToGroupIds),
          validationStatus,
          validationMessage,
          createdAt,
          req.user.uid,
          profile.id,
          profile.name
        );
      }
    });
    tx();

    let share = { status: delivery === "kanwang_share" ? "pending" : "not_requested" };
    if (delivery === "kanwang_share") {
      const batch = db.prepare("SELECT * FROM take_batches WHERE id = ?").get(batchId);
      try {
        share = await shareBatchToPan(batch);
      } catch (error) {
        share = {
          status: "failed",
          error: error.message
        };
      }
    }

    res.json({
      batch_id: batchId,
      delivery,
      profile: publicProfile(profile),
      requested_count: requested,
      issued_count: selected.length,
      validation_status: validationStatus,
      validation_message: validationMessage,
      remote_move_status: moveStatus,
      download_url: `/api/take/${batchId}/download`,
      share,
      accounts: selected.map((account) => ({
        id: account.id,
        name: account.name,
        platform: account.platform,
        type: account.type,
        group_ids: groupIdsOf(account)
      }))
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/take/:id/restore", requireAuth, async (req, res) => {
  try {
    const batch = db.prepare("SELECT * FROM take_batches WHERE id = ?").get(req.params.id);
    if (!batch) return res.status(404).json({ error: "取号批次不存在" });
    if (!canAccessBatch(req, batch)) return res.status(403).json({ error: "不能操作其他用户的取号批次" });
    const result = await restoreMovedBatch(batch);
    res.json({ ok: true, batch_id: batch.id, ...result });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/take/:id/share", requireAuth, async (req, res) => {
  try {
    const batch = db.prepare("SELECT * FROM take_batches WHERE id = ?").get(req.params.id);
    if (!batch) return res.status(404).json({ error: "take batch not found" });
    if (!canAccessBatch(req, batch)) return res.status(403).json({ error: "cannot share another user's batch" });
    const share = await shareBatchToPan(batch);
    res.json({ ok: true, batch_id: batch.id, share });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/take/:id/download", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM take_batches WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "取号批次不存在" });
  if (req.user.role !== "admin" && row.user_id !== req.user.uid) {
    return res.status(403).json({ error: "不能下载其他用户的取号文件" });
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="sub2api-accounts-${row.id}.json"`);
  res.send(row.export_json);
});

app.get("/api/front/records", requireAuth, (req, res) => {
  const batches = db.prepare(`
    SELECT id, profile_id, profile_name, requested_count, issued_count, validate_requested,
           validation_status, remote_move_status, restore_status, restored_at, delivery_method,
           share_status, share_url, share_pwd, share_error, shared_at, created_at
    FROM take_batches
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 100
  `).all(req.user.uid);
  const records = db.prepare(`
    SELECT id, batch_id, profile_id, profile_name, remote_account_id, account_name, platform, type,
           status, validation_status, created_at
    FROM take_records
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 300
  `).all(req.user.uid);
  res.json({ batches, records });
});

app.get("/api/admin/overview", requireAuth, requireAdmin, (req, res) => {
  res.json(adminOverview());
});

app.get("/api/admin/pan123/status", requireAuth, requireAdmin, (req, res) => {
  res.json(pan123PublicStatus());
});

app.post("/api/admin/pan123/config", requireAuth, requireAdmin, (req, res) => {
  try {
    savePan123Config(req.body || {});
    res.json({ ok: true, status: pan123PublicStatus() });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/admin/pan123/login", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (req.body?.config) savePan123Config(req.body.config);
    const status = await loginPan123WithConfiguredMethod(req.body?.method);
    res.json({ ok: true, status });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/admin/pan123/login-api", requireAuth, requireAdmin, async (req, res) => {
  try {
    savePan123Config({ ...(req.body?.config || pan123StoredConfig()), login_method: "api" });
    const status = await loginPan123WithApi();
    res.json({ ok: true, status });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/admin/pan123/login-web", requireAuth, requireAdmin, async (req, res) => {
  try {
    savePan123Config({ ...(req.body?.config || pan123StoredConfig()), login_method: "playwright" });
    const status = await loginPan123WithPlaywright();
    res.json({ ok: true, status });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/admin/pan123/login-code", requireAuth, requireAdmin, async (req, res) => {
  res.status(410).json({ error: "123云盘登录已改为 Playwright 账密网页登录，请使用网页登录按钮" });
});

app.post("/api/admin/pan123/logout", requireAuth, requireAdmin, (req, res) => {
  setSetting("pan123_auth", {});
  res.json({ ok: true, status: pan123PublicStatus() });
});

app.get("/api/admin/profiles", requireAuth, requireAdmin, (req, res) => {
  const profiles = db.prepare("SELECT * FROM sub2api_profiles ORDER BY id").all()
    .map((profile) => publicProfile(profile, true));
  res.json({ profiles });
});

app.post("/api/admin/profiles", requireAuth, requireAdmin, (req, res) => {
  const body = req.body || {};
  const createdAt = now();
  const result = db.prepare(`
    INSERT INTO sub2api_profiles (
      name, base_url, email, password, source_group_ids, taken_group_ids,
      move_to_taken_group, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(body.name || "Sub2API 账号").trim(),
    String(body.base_url || "").trim(),
    String(body.email || "").trim(),
    String(body.password || ""),
    stringifyIds(body.source_group_ids),
    stringifyIds(body.taken_group_ids),
    body.move_to_taken_group ? 1 : 0,
    body.enabled === false ? 0 : 1,
    createdAt,
    createdAt
  );
  const profile = getProfile(result.lastInsertRowid);
  res.json({ profile: publicProfile(profile, true) });
});

app.put("/api/admin/profiles/:id", requireAuth, requireAdmin, (req, res) => {
  const profile = getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: "Sub2API 账号不存在" });
  const body = req.body || {};
  const password = body.password && body.password !== "********" ? String(body.password) : profile.password;
  db.prepare(`
    UPDATE sub2api_profiles SET
      name = ?, base_url = ?, email = ?, password = ?,
      source_group_ids = ?, taken_group_ids = ?,
      move_to_taken_group = ?, enabled = ?, updated_at = ?
    WHERE id = ?
  `).run(
    String(body.name || profile.name).trim(),
    String(body.base_url || profile.base_url).trim(),
    String(body.email || profile.email).trim(),
    password,
    stringifyIds(body.source_group_ids),
    stringifyIds(body.taken_group_ids),
    body.move_to_taken_group ? 1 : 0,
    body.enabled === false ? 0 : 1,
    now(),
    profile.id
  );
  res.json({ profile: publicProfile(getProfile(profile.id), true) });
});

app.post("/api/admin/profiles/:id/test", requireAuth, requireAdmin, async (req, res) => {
  try {
    const profile = getProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: "Sub2API 账号不存在" });
    const me = await clientForProfile(profile).get("/auth/me");
    res.json({ ok: true, email: me.email, role: me.role, profile: publicProfile(profile) });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/admin/profiles/:id/sync-groups", requireAuth, requireAdmin, async (req, res) => {
  try {
    const profile = getProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: "Sub2API 账号不存在" });
    const groups = await clientForProfile(profile).groups();
    saveGroups(profile.id, groups || []);
    res.json({ profile: publicProfile(profile), groups: groupsForProfile(profile.id) });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT id, username, display_name, role, enabled, created_at, updated_at
    FROM users
    ORDER BY role, id
  `).all().map((user) => ({
    ...user,
    enabled: Boolean(user.enabled),
    profile_ids: userAssignments(user.id)
  }));
  res.json({ users });
});

app.post("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  const body = req.body || {};
  if (!body.username || !body.password) {
    return res.status(400).json({ error: "账号和密码不能为空" });
  }
  try {
    const result = createUser({
      username: String(body.username).trim(),
      password: String(body.password),
      displayName: String(body.display_name || body.username).trim(),
      role: body.role === "admin" ? "admin" : "user",
      enabled: body.enabled !== false
    });
    replaceAssignments(result.lastInsertRowid, body.profile_ids || []);
    const user = db.prepare(`
      SELECT id, username, display_name, role, enabled, created_at, updated_at
      FROM users WHERE id = ?
    `).get(result.lastInsertRowid);
    res.json({ user: { ...user, enabled: Boolean(user.enabled), profile_ids: userAssignments(user.id) } });
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "账号已存在" });
    }
    handleError(res, error);
  }
});

app.put("/api/admin/users/:id", requireAuth, requireAdmin, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "用户不存在" });
  const body = req.body || {};
  const patch = {
    username: String(body.username || user.username).trim(),
    display_name: String(body.display_name || user.display_name || "").trim(),
    role: body.role === "admin" ? "admin" : "user",
    enabled: body.enabled === false ? 0 : 1,
    updated_at: now(),
    id: user.id
  };
  if (body.password) {
    const { salt, hash } = hashPassword(String(body.password));
    patch.salt = salt;
    patch.password_hash = hash;
    db.prepare(`
      UPDATE users SET username = @username, display_name = @display_name, role = @role,
        enabled = @enabled, salt = @salt, password_hash = @password_hash, updated_at = @updated_at
      WHERE id = @id
    `).run(patch);
  } else {
    db.prepare(`
      UPDATE users SET username = @username, display_name = @display_name, role = @role,
        enabled = @enabled, updated_at = @updated_at
      WHERE id = @id
    `).run(patch);
  }
  replaceAssignments(user.id, body.profile_ids || []);
  res.json({ ok: true });
});

app.get("/api/admin/records", requireAuth, requireAdmin, (req, res) => {
  const batches = db.prepare(`
    SELECT b.id, b.user_id, b.profile_id, b.profile_name, b.requested_count, b.issued_count,
           b.validate_requested, b.validation_status, b.remote_move_status, b.restore_status, b.restored_at,
           b.delivery_method, b.share_status, b.share_url, b.share_pwd, b.share_error, b.shared_at,
           b.created_by, b.created_at,
           u.username
    FROM take_batches b
    LEFT JOIN users u ON u.id = b.user_id
    ORDER BY b.created_at DESC
    LIMIT 200
  `).all();
  const records = db.prepare(`
    SELECT r.id, r.batch_id, r.user_id, r.profile_id, r.profile_name, r.remote_account_id,
           r.account_name, r.platform, r.type, r.status, r.validation_status, r.created_at,
           u.username
    FROM take_records r
    LEFT JOIN users u ON u.id = r.user_id
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT 500
  `).all();
  res.json({ batches, records });
});

app.delete("/api/admin/batches/:id", requireAuth, requireAdmin, (req, res) => {
  const batch = db.prepare("SELECT * FROM take_batches WHERE id = ?").get(req.params.id);
  if (!batch) return res.status(404).json({ error: "取号批次不存在" });
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM take_records WHERE batch_id = ?").run(batch.id);
    db.prepare("DELETE FROM take_batches WHERE id = ?").run(batch.id);
  });
  tx();
  res.json({ ok: true, deleted_batch_id: batch.id });
});

// Compatibility endpoints for the previous UI shape.
app.get("/api/records", requireAuth, (req, res) => {
  if (req.user.role === "admin") return res.redirect(307, "/api/admin/records");
  return res.redirect(307, "/api/front/records");
});

app.use((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(port, () => {
  console.log(`Sub2API picker is running on http://0.0.0.0:${port}`);
});
