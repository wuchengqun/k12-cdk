const crypto = require("crypto");

const EXPORT_FORMATS = new Set(["sub2api", "cpa", "cockpit", "9router"]);

function normalizeExportFormat(value) {
  const format = String(value || "").trim().toLowerCase();
  return EXPORT_FORMATS.has(format) ? format : "sub2api";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function stripUnavailable(value) {
  if (Array.isArray(value)) {
    const items = value.map(stripUnavailable).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, stripUnavailable(item)])
      .filter(([, item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  if (value === undefined || value === null || value === "") return undefined;
  return value;
}

function normalizeTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value > 1e11 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function getExpiresIn(expiresAt, now = new Date()) {
  if (!expiresAt) return undefined;
  const expiresMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiresMs)) return undefined;
  return Math.max(0, Math.floor((expiresMs - now.getTime()) / 1000));
}

function toEmailKey(email) {
  if (typeof email !== "string") return undefined;
  return email
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function decodeBase64Url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="), "base64").toString("utf8");
}

function parseJwtPayload(token) {
  if (typeof token !== "string" || token.trim() === "") return undefined;
  const segments = token.split(".");
  if (segments.length < 2) return undefined;
  try {
    return JSON.parse(decodeBase64Url(segments[1]));
  } catch {
    return undefined;
  }
}

function timestampFromUnixSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return normalizeTimestamp(numeric);
}

function accountCredentials(account) {
  return isPlainObject(account?.credentials) ? account.credentials : {};
}

function providerData(account) {
  return isPlainObject(account?.providerSpecificData) ? account.providerSpecificData : {};
}

function normalizeAccount(account, now = new Date()) {
  account = isPlainObject(account) ? account : {};
  const credentials = accountCredentials(account);
  const providerSpecificData = providerData(account);
  const accessToken = firstNonEmpty(
    credentials.access_token,
    credentials.accessToken,
    account.access_token,
    account.accessToken,
    account.token?.access_token,
    account.tokens?.access_token
  );
  if (!accessToken) {
    const error = new Error(`账号 ${account?.name || account?.id || ""} 缺少 access_token，无法转换格式`);
    error.statusCode = 400;
    throw error;
  }

  const idToken = firstNonEmpty(credentials.id_token, credentials.idToken, account.id_token, account.idToken);
  const jwtPayload = parseJwtPayload(accessToken);
  const jwtAuth = isPlainObject(jwtPayload?.["https://api.openai.com/auth"])
    ? jwtPayload["https://api.openai.com/auth"]
    : {};
  const jwtProfile = isPlainObject(jwtPayload?.["https://api.openai.com/profile"])
    ? jwtPayload["https://api.openai.com/profile"]
    : {};
  const email = firstNonEmpty(
    credentials.email,
    account.extra?.email,
    account.email,
    providerSpecificData.email,
    jwtProfile.email,
    jwtPayload?.email
  );
  const accountId = firstNonEmpty(
    credentials.chatgpt_account_id,
    credentials.chatgptAccountId,
    account.chatgpt_account_id,
    account.chatgptAccountId,
    account.account_id,
    providerSpecificData.chatgptAccountId,
    providerSpecificData.chatgpt_account_id,
    jwtAuth.chatgpt_account_id
  );
  const userId = firstNonEmpty(
    credentials.chatgpt_user_id,
    credentials.chatgptUserId,
    account.chatgpt_user_id,
    providerSpecificData.chatgptUserId,
    providerSpecificData.chatgpt_user_id,
    jwtAuth.chatgpt_user_id,
    jwtAuth.user_id
  );
  const planType = firstNonEmpty(
    credentials.plan_type,
    credentials.planType,
    account.plan_type,
    account.planType,
    providerSpecificData.chatgptPlanType,
    providerSpecificData.chatgpt_plan_type,
    jwtAuth.chatgpt_plan_type
  );
  const expiresAt = firstNonEmpty(
    normalizeTimestamp(credentials.expires_at),
    normalizeTimestamp(credentials.expiresAt),
    normalizeTimestamp(account.expires_at),
    normalizeTimestamp(account.expiresAt),
    timestampFromUnixSeconds(jwtPayload?.exp)
  );
  const exportedAt = normalizeTimestamp(now);
  const name = firstNonEmpty(account.name, email, accountId, "ChatGPT Account");

  return {
    accessToken,
    refreshToken: firstNonEmpty(credentials.refresh_token, credentials.refreshToken, account.refresh_token, account.refreshToken) || "",
    idToken,
    sessionToken: firstNonEmpty(credentials.session_token, credentials.sessionToken, account.session_token, account.sessionToken),
    accountId,
    userId,
    email,
    name,
    planType,
    expiresAt,
    expiresIn: Number.isFinite(Number(credentials.expires_in))
      ? Number(credentials.expires_in)
      : getExpiresIn(expiresAt, now),
    exportedAt,
    disabled: Boolean(account.disabled),
    priority: Number.isFinite(Number(account.priority)) ? Number(account.priority) : undefined,
    source: firstNonEmpty(account.extra?.source, "sub2api_export"),
    authProvider: firstNonEmpty(account.extra?.auth_provider, account.authProvider, account.auth_provider)
  };
}

function toCpa(item) {
  return Object.fromEntries(Object.entries({
    type: "codex",
    account_id: item.accountId,
    chatgpt_account_id: item.accountId,
    email: item.email,
    name: item.name,
    plan_type: item.planType,
    chatgpt_plan_type: item.planType,
    id_token: item.idToken,
    access_token: item.accessToken,
    refresh_token: item.refreshToken || "",
    session_token: item.sessionToken,
    last_refresh: item.exportedAt,
    expired: item.expiresAt,
    disabled: item.disabled || undefined
  }).filter(([, value]) => value !== undefined && value !== null));
}

function toCockpit(item) {
  return stripUnavailable({
    type: "codex",
    id_token: item.idToken,
    access_token: item.accessToken,
    refresh_token: item.refreshToken || "",
    session_token: item.sessionToken,
    account_id: item.accountId,
    last_refresh: item.exportedAt,
    email: item.email,
    expired: item.expiresAt
  });
}

function toNineRouter(item, account) {
  return stripUnavailable({
    accessToken: item.accessToken,
    refreshToken: item.refreshToken || undefined,
    expiresAt: item.expiresAt,
    testStatus: firstNonEmpty(account.testStatus, account.test_status, "active"),
    expiresIn: item.expiresIn,
    providerSpecificData: {
      chatgptAccountId: item.accountId,
      chatgptPlanType: item.planType
    },
    id: item.accountId || crypto.createHash("sha1").update(item.accessToken).digest("hex"),
    provider: "codex",
    authType: "oauth",
    name: item.name,
    email: item.email,
    priority: item.priority ?? 9,
    isActive: !item.disabled,
    createdAt: normalizeTimestamp(account.createdAt) || item.exportedAt,
    updatedAt: normalizeTimestamp(account.updatedAt) || item.exportedAt
  });
}

function toSub2apiAccount(item, account) {
  return stripUnavailable({
    name: item.name,
    platform: account.platform || "openai",
    type: account.type || "oauth",
    concurrency: Number.isFinite(Number(account.concurrency)) ? Number(account.concurrency) : 10,
    priority: Number.isFinite(Number(account.priority)) ? Number(account.priority) : 1,
    credentials: {
      access_token: item.accessToken,
      refresh_token: item.refreshToken || undefined,
      id_token: item.idToken,
      session_token: item.sessionToken,
      chatgpt_account_id: item.accountId,
      chatgpt_user_id: item.userId,
      email: item.email,
      expires_at: item.expiresAt,
      expires_in: item.expiresIn,
      plan_type: item.planType
    },
    extra: {
      email: item.email,
      email_key: toEmailKey(item.email),
      name: item.name,
      auth_provider: item.authProvider,
      source: item.source,
      last_refresh: item.exportedAt
    }
  });
}

function formatExportDocument(sourceDocument, format, now = new Date()) {
  const exportFormat = normalizeExportFormat(format);
  if (exportFormat === "sub2api") return sourceDocument;

  const accounts = Array.isArray(sourceDocument?.accounts) ? sourceDocument.accounts : [];
  const converted = accounts.map((account) => {
    const item = normalizeAccount(account, now);
    if (exportFormat === "cpa") return toCpa(item);
    if (exportFormat === "cockpit") return toCockpit(item);
    if (exportFormat === "9router") return toNineRouter(item, account);
    return toSub2apiAccount(item, account);
  });

  return converted.length === 1 ? converted[0] : converted;
}

function exportFormatLabel(format) {
  return {
    sub2api: "Sub2API",
    cpa: "CPA",
    cockpit: "Cockpit",
    "9router": "9router"
  }[normalizeExportFormat(format)];
}

module.exports = {
  formatExportDocument,
  normalizeExportFormat,
  exportFormatLabel
};
