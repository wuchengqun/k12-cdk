class Sub2ApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = "Sub2ApiError";
    this.status = status;
    this.detail = detail;
  }
}

function rootUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

function apiUrl(config, path) {
  const baseUrl = rootUrl(config.base_url || config.sub2api_url);
  if (!baseUrl) throw new Sub2ApiError("Sub2API 地址未配置", 400, null);
  return `${baseUrl}/api/v1${path}`;
}

function unwrap(payload) {
  if (payload && typeof payload === "object" && "code" in payload) {
    if (payload.code !== 0) {
      throw new Sub2ApiError(payload.message || "Sub2API 请求失败", 200, payload);
    }
    return payload.data;
  }
  return payload;
}

class Sub2ApiClient {
  constructor(config) {
    this.config = config;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async login() {
    const response = await fetch(apiUrl(this.config, "/auth/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        email: this.config.email || this.config.sub2api_email,
        password: this.config.password || this.config.sub2api_password
      })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Sub2ApiError("Sub2API 登录失败", response.status, payload);
    }
    const data = unwrap(payload);
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + ((data.expires_in || 1800) - 60) * 1000;
    if (!this.token) throw new Sub2ApiError("Sub2API 登录响应缺少 access_token", response.status, payload);
    return data;
  }

  async ensureToken() {
    if (!this.token || Date.now() > this.tokenExpiresAt) await this.login();
    return this.token;
  }

  async request(path, options = {}) {
    const token = await this.ensureToken();
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    };
    const response = await fetch(apiUrl(this.config, path), { ...options, headers });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      throw new Sub2ApiError(`Sub2API 请求失败：${path}`, response.status, payload);
    }
    return unwrap(payload);
  }

  async rawRequest(path, options = {}) {
    const token = await this.ensureToken();
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    };
    const response = await fetch(apiUrl(this.config, path), { ...options, headers });
    const text = await response.text();
    if (!response.ok) {
      throw new Sub2ApiError(`Sub2API 请求失败：${path}`, response.status, text);
    }
    return text;
  }

  get(path) {
    return this.request(path);
  }

  post(path, body) {
    return this.request(path, { method: "POST", body: JSON.stringify(body || {}) });
  }

  async groups() {
    return this.get("/admin/groups/all?include_inactive=true");
  }

  async accounts(page = 1, pageSize = 100, filters = {}) {
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    }
    return this.get(`/admin/accounts?${params.toString()}`);
  }

  async listAccountsFromGroups(groupIds = [], maxPagesPerGroup = 20) {
    if (!groupIds.length) return [];
    const unique = new Map();
    const groupList = groupIds;
    for (const groupId of groupList) {
      let page = 1;
      let pages = 1;
      do {
        const filters = { status: "active" };
        if (groupId) filters.group = groupId;
        const data = await this.accounts(page, 100, filters);
        const items = data.items || [];
        for (const item of items) {
          const existing = unique.get(item.id);
          const sourceGroupIds = [
            ...new Set([
              ...((existing && existing._source_group_ids) || []),
              Number(groupId)
            ].filter((id) => Number.isInteger(id) && id > 0))
          ];
          unique.set(item.id, { ...(existing || {}), ...item, _source_group_ids: sourceGroupIds });
        }
        pages = Math.min(data.pages || 1, maxPagesPerGroup);
        page += 1;
      } while (page <= pages);
    }
    return [...unique.values()];
  }

  async batchRefresh(accountIds) {
    if (!accountIds.length) return null;
    return this.post("/admin/accounts/batch-refresh", { account_ids: accountIds });
  }

  async testAccount(accountId) {
    return this.rawRequest(`/admin/accounts/${accountId}/test`, { method: "POST" });
  }

  async exportAccounts(accountIds) {
    const params = new URLSearchParams({
      ids: accountIds.join(","),
      include_proxies: "false"
    });
    return this.get(`/admin/accounts/data?${params.toString()}`);
  }

  async moveAccounts(accountIds, groupIds) {
    if (!accountIds.length || !groupIds.length) return null;
    return this.post("/admin/accounts/bulk-update", {
      account_ids: accountIds,
      group_ids: groupIds
    });
  }
}

module.exports = {
  Sub2ApiClient,
  Sub2ApiError
};
