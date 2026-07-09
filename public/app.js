const state = {
  user: null,
  mode: "front",
  tab: "home",
  dashboard: null,
  admin: {
    overview: null,
    profiles: [],
    users: [],
    records: { batches: [], records: [] },
    pan123: null
  },
  availability: null,
  availabilityLoading: false,
  notice: "",
  error: "",
  busy: false
};

const app = document.getElementById("app");

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    credentials: "same-origin",
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

function setMessage(notice = "", error = "") {
  state.notice = notice;
  state.error = error;
  render();
}

function setBusy(value) {
  state.busy = value;
  render();
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.focus();
  area.select();
  document.execCommand("copy");
  area.remove();
}

async function loadFront() {
  state.dashboard = await api("/api/front/dashboard");
}

async function loadAdmin() {
  if (state.user?.role !== "admin") return;
  const [overview, profiles, users, records, pan123] = await Promise.all([
    api("/api/admin/overview"),
    api("/api/admin/profiles"),
    api("/api/admin/users"),
    api("/api/admin/records"),
    api("/api/admin/pan123/status")
  ]);
  state.admin.overview = overview;
  state.admin.profiles = profiles.profiles || [];
  state.admin.users = users.users || [];
  state.admin.records = records;
  state.admin.pan123 = pan123;
}

async function loadAvailability(profileId = null) {
  const targetProfileId = Number(profileId || currentTakeProfileId() || 0);
  if (!targetProfileId) {
    state.availability = null;
    return;
  }
  state.availability = await api(`/api/front/availability?profile_id=${targetProfileId}`);
}

async function refreshAvailability(profileId = null, { silent = false } = {}) {
  state.availabilityLoading = true;
  if (!silent) render();
  try {
    await loadAvailability(profileId);
  } finally {
    state.availabilityLoading = false;
  }
}

async function refreshTakeAvailabilityIfPossible() {
  if (!usableProfiles().length) {
    state.availability = null;
    state.availabilityLoading = false;
    return;
  }
  await refreshAvailability(null, { silent: true });
}

async function boot() {
  try {
    const session = await api("/api/session");
    state.user = session.user;
    await loadFront();
    if (state.user.role === "admin") await loadAdmin();
  } catch {
    state.user = null;
  }
  render();
}

function profiles() {
  return state.dashboard?.profiles || [];
}

function usableProfiles() {
  return profiles().filter((profile) => (profile.source_group_ids || []).length > 0);
}

function currentTakeProfileId() {
  const selected = Number(document.getElementById("profile-id")?.value || 0);
  if (selected) return selected;
  if (state.availability?.profile?.id) return Number(state.availability.profile.id);
  return Number(usableProfiles()[0]?.id || profiles()[0]?.id || 0);
}

function loginView() {
  return `
    <section class="login-shell">
      <form class="login-panel" id="login-form">
        <div class="login-mark">S2A</div>
        <h1>Sub2API 取号平台</h1>
        <p>前台用户取号，后台统一分配 Sub2API 账号。</p>
        <div class="field">
          <label for="username">登录账号</label>
          <input id="username" name="username" autocomplete="username" required value="user" />
        </div>
        <div class="field">
          <label for="password">登录密码</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required />
        </div>
        <button class="btn primary wide" type="submit">登录</button>
        <p class="hint">默认前台：user / user123456；默认后台：admin / admin123456</p>
        ${state.error ? `<div class="notice error">${escapeHtml(state.error)}</div>` : ""}
      </form>
    </section>
  `;
}

function shellView() {
  const nav = state.mode === "admin" ? adminNav() : frontNav();
  return `
    <section class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-badge">S2A</div>
          <div>
            <strong>取号平台</strong>
            <span>${escapeHtml(state.user.display_name || state.user.username)}</span>
          </div>
        </div>
        <div class="mode-switch">
          <button data-mode="front" class="${state.mode === "front" ? "active" : ""}">前台取号</button>
          ${state.user.role === "admin" ? `<button data-mode="admin" class="${state.mode === "admin" ? "active" : ""}">后台配置</button>` : ""}
        </div>
        <nav class="nav">${nav}</nav>
        <button class="logout" id="logout-button">退出登录</button>
      </aside>
      <main class="content">
        <header class="topbar">
          <div>
            <p class="eyebrow">${state.mode === "admin" ? "Admin Console" : "User Portal"}</p>
            <h1>${pageTitle()}</h1>
          </div>
          <div class="user-pill">${escapeHtml(state.user.role === "admin" ? "管理员" : "前台用户")}</div>
        </header>
        ${state.error ? `<div class="notice error">${escapeHtml(state.error)}</div>` : ""}
        ${state.notice ? `<div class="notice">${escapeHtml(state.notice)}</div>` : ""}
        ${state.mode === "admin" ? adminView() : frontView()}
      </main>
    </section>
  `;
}

function frontNav() {
  return [
    ["home", "首页"],
    ["take", "取号"],
    ["frontRecords", "我的记录"]
  ].map(([id, label]) => `<button data-tab="${id}" class="${state.tab === id ? "active" : ""}">${label}</button>`).join("");
}

function adminNav() {
  return [
    ["adminHome", "后台首页"],
    ["pan123", "123云盘"],
    ["profiles", "Sub2API账号"],
    ["users", "用户分配"],
    ["adminRecords", "取号记录"]
  ].map(([id, label]) => `<button data-tab="${id}" class="${state.tab === id ? "active" : ""}">${label}</button>`).join("");
}

function pageTitle() {
  const titles = {
    home: "首页统计",
    take: "前台取号",
    frontRecords: "我的取号记录",
    adminHome: "后台统计",
    pan123: "123 云盘登录",
    profiles: "Sub2API 账号配置",
    users: "用户与分配",
    adminRecords: "全部取号记录"
  };
  return titles[state.tab] || "Sub2API 取号平台";
}

function frontView() {
  if (state.tab === "take") return takeView();
  if (state.tab === "frontRecords") return frontRecordsView();
  return frontHomeView();
}

function adminView() {
  if (state.tab === "pan123") return pan123View();
  if (state.tab === "profiles") return profilesView();
  if (state.tab === "users") return usersView();
  if (state.tab === "adminRecords") return adminRecordsView();
  return adminHomeView();
}

function frontHomeView() {
  const dashboard = state.dashboard || { total_taken: 0, total_batches: 0, profiles: [], recent: [] };
  return `
    <section class="hero-panel">
      <div>
        <p class="eyebrow">当前账号</p>
        <h2>${escapeHtml(state.user.display_name || state.user.username)}</h2>
        <p>这里展示你的可用 Sub2API 账号、累计取号数量和最近取号记录。</p>
      </div>
      <div class="hero-number">
        <b>${dashboard.total_taken}</b>
        <span>已取账号</span>
      </div>
    </section>
    <section class="stats">
      <div class="stat"><b>${dashboard.total_taken}</b><span>累计取号</span></div>
      <div class="stat"><b>${dashboard.today_taken || 0}</b><span>今日取号</span></div>
      <div class="stat"><b>${dashboard.total_batches}</b><span>取号批次</span></div>
    </section>
    <section class="panel">
      <h2>按 Sub2API 账号统计</h2>
      <div class="profile-grid">
        ${dashboard.profiles.map(profileCard).join("") || `<p class="muted">还没有分配可用的 Sub2API 账号。</p>`}
      </div>
    </section>
    <section class="panel">
      <h2>最近取号</h2>
      ${batchTable(dashboard.recent || [], false)}
    </section>
    <section class="panel">
      <h2>按天统计</h2>
      ${dailyStatsTable(dashboard.daily_stats || [])}
    </section>
  `;
}

function profileCard(profile) {
  return `
    <article class="profile-card">
      <div>
        <strong>${escapeHtml(profile.name)}</strong>
        <span>${escapeHtml(profile.email)}</span>
      </div>
      <div class="mini-stats">
        <span><b>${profile.taken_count || 0}</b> 已取</span>
        <span><b>${profile.batch_count || 0}</b> 批次</span>
      </div>
    </article>
  `;
}

function profileSelect() {
  const selectedId = currentTakeProfileId();
  return `
    <select id="profile-id" name="profile_id" required>
      ${profiles().map((profile) => {
        const hasSourceGroups = (profile.source_group_ids || []).length > 0;
        return `<option value="${profile.id}" ${Number(profile.id) === selectedId ? "selected" : ""} ${hasSourceGroups ? "" : "disabled"}>${escapeHtml(profile.name)} · ${escapeHtml(profile.email)}${hasSourceGroups ? "" : "（未配置取号分组）"}</option>`;
      }).join("")}
    </select>
  `;
}

function availabilityPanel() {
  const info = state.availability;
  if (state.availabilityLoading && !info) {
    return `
      <div class="extractable-card loading">
        <div>
          <p class="eyebrow">可提取数量（未验活）</p>
          <b>统计中</b>
          <span>正在读取当前取号分组下的账号数量。</span>
        </div>
      </div>
    `;
  }
  if (!info) {
    return `
      <div class="extractable-card empty">
        <div>
          <p class="eyebrow">可提取数量（未验活）</p>
          <b>-</b>
          <span>进入取号页会自动刷新，也可以点击“刷新可提取数量”。</span>
        </div>
      </div>
    `;
  }
  return `
    <div class="extractable-card">
      <div class="availability-total">
        <p class="eyebrow">可提取数量（未验活）</p>
        <b>${info.total_remaining}</b>
        <span>当前 Sub2API 账号的取号分组可提取账号总数</span>
      </div>
      <div class="availability-groups">
        <strong>分组明细</strong>
        ${(info.groups || []).map((group) => `
          <span>${escapeHtml(group.name)}：<b>${group.remaining_count}</b> 个</span>
        `).join("") || `<span class="muted">没有取号分组</span>`}
      </div>
    </div>
  `;
}

function takeView() {
  if (!profiles().length) {
    return `<section class="panel empty"><h2>暂无可用账号</h2><p>请联系管理员给你分配 Sub2API 账号。</p></section>`;
  }
  if (!usableProfiles().length) {
    return `<section class="panel empty"><h2>没有可取号的分组</h2><p>你已分配 Sub2API 账号，但这些账号还没有配置取号分组。请联系管理员先在后台勾选取号分组。</p></section>`;
  }
  return `
    <section class="panel take-panel">
      <div class="section-head">
        <div>
          <h2>取号</h2>
          <p>先确认可提取数量（未验活），再输入数量，并选择下载 JSON 或卡网分享。</p>
        </div>
      </div>
      ${availabilityPanel()}
      <form id="take-form" class="form-grid">
        <div class="field">
          <label>Sub2API 账号</label>
          ${profileSelect()}
        </div>
        <div class="field">
          <label for="take-count">取号数量</label>
          <input id="take-count" name="count" type="number" min="1" max="500" value="1" required />
        </div>
        <label class="toggle">
          <input name="validate" type="checkbox" checked />
          <span>取号前批量验活</span>
        </label>
        <div class="field delivery-field">
          <label>取号后处理</label>
          <div class="segmented">
            <label>
              <input type="radio" name="delivery" value="download" checked />
              <span>下载 JSON</span>
            </label>
            <label>
              <input type="radio" name="delivery" value="kanwang_share" />
              <span>卡网分享</span>
            </label>
          </div>
        </div>
        <div class="actions">
          <button class="btn primary" ${state.busy ? "disabled" : ""} type="submit">开始取号</button>
          <button class="btn ghost" ${state.busy ? "disabled" : ""} type="button" id="validate-button">只验活</button>
          <button class="btn ghost" ${state.busy || state.availabilityLoading ? "disabled" : ""} type="button" id="refresh-availability">刷新可提取数量</button>
        </div>
      </form>
    </section>
  `;
}

function frontRecordsView() {
  const rows = state.dashboard?.recent || [];
  return `
    <section class="panel">
      <h2>我的最近批次</h2>
      ${batchTable(rows, false)}
    </section>
  `;
}

function adminHomeView() {
  const overview = state.admin.overview || { total_users: 0, total_profiles: 0, total_taken: 0, per_profile: [], per_user: [] };
  return `
    <section class="stats">
      <div class="stat"><b>${overview.total_taken}</b><span>总取号数量</span></div>
      <div class="stat"><b>${overview.today_taken || 0}</b><span>今日取号数量</span></div>
      <div class="stat"><b>${overview.total_users}</b><span>前台用户</span></div>
    </section>
    <section class="panel">
      <h2>按天统计</h2>
      ${dailyStatsTable(overview.daily_stats || [])}
    </section>
    <section class="grid-2">
      <div class="panel">
        <h2>按 Sub2API 账号统计</h2>
        ${smallStatTable(overview.per_profile, "name")}
      </div>
      <div class="panel">
        <h2>按用户统计</h2>
        ${smallStatTable(overview.per_user, "username")}
      </div>
    </section>
  `;
}

function pan123View() {
  const status = state.admin.pan123 || {};
  const config = status.config || {};
  const stateText = status.logged_in ? "已登录" : "未登录";
  const credentialText = status.has_token ? "Token" : status.has_cookie ? "Cookie" : "-";
  const userText = status.user?.nickname || status.user?.passport || "-";
  const loginMethod = config.login_method === "playwright" ? "playwright" : "api";
  return `
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>123 云盘登录配置</h2>
          <p>接口登录会直接用 123 云盘接口获取 token；Playwright 登录会打开官方登录页，也可以切换无头模式。登录成功后，卡网分享会继续走接口复用凭证。</p>
        </div>
      </div>
      <div class="stats compact-stats">
        <div class="stat"><b>${escapeHtml(stateText)}</b><span>当前状态</span></div>
        <div class="stat"><b>${escapeHtml(status.account || "-")}</b><span>账号</span></div>
        <div class="stat"><b>${escapeHtml(credentialText)}</b><span>凭证类型</span></div>
      </div>
      <div class="stats compact-stats">
        <div class="stat"><b>${escapeHtml(userText)}</b><span>云盘用户</span></div>
        <div class="stat"><b>${escapeHtml(status.user?.uid || "-")}</b><span>UID</span></div>
        <div class="stat"><b>${escapeHtml(status.user?.file_count ?? "-")}</b><span>文件数</span></div>
      </div>
      <form id="pan123-config-form" class="form-grid compact-form">
        <div class="field">
          <label for="pan123-account">123 云盘账号</label>
          <input id="pan123-account" name="account" autocomplete="username" value="${escapeHtml(config.account || "")}" />
        </div>
        <div class="field">
          <label for="pan123-password">123 云盘密码</label>
          <input id="pan123-password" name="password" type="password" autocomplete="current-password" placeholder="${config.has_password ? "已从配置文件读取，留空不修改" : ""}" />
        </div>
        <div class="field">
          <label for="pan123-login-method">登录方式</label>
          <select id="pan123-login-method" name="login_method">
            <option value="api" ${loginMethod === "api" ? "selected" : ""}>接口登录</option>
            <option value="playwright" ${loginMethod === "playwright" ? "selected" : ""}>Playwright 登录</option>
          </select>
        </div>
        <label class="toggle">
          <input name="playwright_headless" type="checkbox" ${config.playwright_headless ? "checked" : ""} />
          <span>Playwright 无头模式</span>
        </label>
        <div class="field">
          <label for="pan123-timeout">Playwright 超时（毫秒）</label>
          <input id="pan123-timeout" name="playwright_timeout_ms" type="number" min="10000" max="300000" step="1000" value="${escapeHtml(config.playwright_timeout_ms || 90000)}" />
        </div>
        <div class="actions">
          <button class="btn primary" type="button" id="pan123-login" ${state.busy ? "disabled" : ""}>按配置登录</button>
          <button class="btn ghost" type="submit" ${state.busy ? "disabled" : ""}>保存配置</button>
          <button class="btn ghost" type="button" id="pan123-refresh" ${state.busy ? "disabled" : ""}>刷新状态</button>
          ${status.logged_in ? `<button class="btn danger" type="button" id="pan123-logout" ${state.busy ? "disabled" : ""}>清除登录</button>` : ""}
        </div>
      </form>
      <p class="muted">接口登录速度更快；如果接口登录被风控或没有返回 token，可切换到 Playwright 登录。无头模式适合服务器运行，有头模式适合需要手动处理页面验证时使用。</p>
      ${status.updated_at ? `<p class="muted">上次登录：${escapeHtml(fmtDate(status.updated_at))}</p>` : ""}
      ${status.configured ? "" : `<div class="notice error">还没有配置 123 云盘账号或密码。</div>`}
    </section>
  `;
}

function smallStatTable(rows, nameKey) {
  return `
    <table>
      <thead><tr><th>名称</th><th>取号</th><th>批次</th></tr></thead>
      <tbody>
        ${(rows || []).map((row) => `
          <tr>
            <td>${escapeHtml(row[nameKey] || row.display_name || row.email || "-")}</td>
            <td>${row.taken_count || 0}</td>
            <td>${row.batch_count || 0}</td>
          </tr>
        `).join("") || `<tr><td colspan="3" class="muted">暂无数据</td></tr>`}
      </tbody>
    </table>
  `;
}

function dailyStatsTable(rows) {
  return `
    <table>
      <thead><tr><th>日期</th><th>取号数量</th><th>批次数</th></tr></thead>
      <tbody>
        ${(rows || []).map((row) => `
          <tr>
            <td>${escapeHtml(row.day || "-")}</td>
            <td>${row.taken_count || 0}</td>
            <td>${row.batch_count || 0}</td>
          </tr>
        `).join("") || `<tr><td colspan="3" class="muted">暂无数据</td></tr>`}
      </tbody>
    </table>
  `;
}

function profilesView() {
  return `
    <section class="panel">
      <div class="section-head">
        <div>
          <h2>新增 Sub2API 账号</h2>
          <p>每个账号可以配置独立地址、账密、取号分组和已取号分组。</p>
        </div>
      </div>
      ${profileForm()}
    </section>
    ${(state.admin.profiles || []).map((profile) => `
      <section class="panel profile-config">
        <h2>${escapeHtml(profile.name)}</h2>
        ${profileForm(profile)}
        <div class="group-editor">
          <h3>取号分组</h3>
          ${groupChecks(profile, "source_group_ids")}
          <h3>已取号分组</h3>
          ${groupChecks(profile, "taken_group_ids")}
        </div>
      </section>
    `).join("")}
  `;
}

function profileForm(profile = null) {
  const id = profile?.id || "";
  return `
    <form class="profile-form form-grid" data-profile-form="${id}">
      <div class="field">
        <label>名称</label>
        <input name="name" value="${escapeHtml(profile?.name || "")}" required />
      </div>
      <div class="field">
        <label>访问路径</label>
        <input name="base_url" value="${escapeHtml(profile?.base_url || "")}" placeholder="http://host:8080" required />
      </div>
      <div class="field">
        <label>Sub2API 账号</label>
        <input name="email" value="${escapeHtml(profile?.email || "")}" required />
      </div>
      <div class="field">
        <label>Sub2API 密码</label>
        <input name="password" type="password" value="${escapeHtml(profile?.password || "")}" required />
      </div>
      <label class="toggle">
        <input name="enabled" type="checkbox" ${profile?.enabled === false ? "" : "checked"} />
        <span>启用</span>
      </label>
      <label class="toggle">
        <input name="move_to_taken_group" type="checkbox" ${profile?.move_to_taken_group ? "checked" : ""} />
        <span>取号后移动到已取号分组</span>
      </label>
      <div class="actions">
        <button class="btn primary" type="submit" ${state.busy ? "disabled" : ""}>${profile ? "保存账号" : "新增账号"}</button>
        ${profile ? `<button class="btn ghost" type="button" data-test-profile="${profile.id}">测试连接</button>
        <button class="btn ghost" type="button" data-sync-profile="${profile.id}">同步分组</button>` : ""}
      </div>
    </form>
  `;
}

function groupChecks(profile, field) {
  const picked = new Set(profile[field] || []);
  return `
    <div class="group-list">
      ${(profile.groups || []).map((group) => `
        <label class="check-row">
          <input type="checkbox" name="${field}_${profile.id}" value="${group.id}" ${picked.has(group.id) ? "checked" : ""} />
          <div>
            <strong>${escapeHtml(group.name)}</strong>
            <span>ID ${group.id} · ${escapeHtml(group.platform || "unknown")} · ${escapeHtml(group.status || "")}</span>
          </div>
        </label>
      `).join("") || `<p class="muted">还没有同步分组。</p>`}
    </div>
  `;
}

function usersView() {
  return `
    <section class="panel">
      <h2>新增前台用户</h2>
      ${userForm()}
    </section>
    <section class="panel">
      <h2>用户分配</h2>
      <div class="user-list">
        ${(state.admin.users || []).map(userForm).join("")}
      </div>
    </section>
  `;
}

function userForm(user = null) {
  const isExisting = Boolean(user);
  return `
    <form class="user-form" data-user-form="${user?.id || ""}">
      <div class="form-grid compact">
        <div class="field">
          <label>登录账号</label>
          <input name="username" value="${escapeHtml(user?.username || "")}" required />
        </div>
        <div class="field">
          <label>显示名称</label>
          <input name="display_name" value="${escapeHtml(user?.display_name || "")}" />
        </div>
        <div class="field">
          <label>${isExisting ? "新密码" : "登录密码"}</label>
          <input name="password" type="password" ${isExisting ? "" : "required"} />
        </div>
        <div class="field">
          <label>角色</label>
          <select name="role">
            <option value="user" ${user?.role !== "admin" ? "selected" : ""}>前台用户</option>
            <option value="admin" ${user?.role === "admin" ? "selected" : ""}>管理员</option>
          </select>
        </div>
      </div>
      <label class="toggle">
        <input name="enabled" type="checkbox" ${user?.enabled === false ? "" : "checked"} />
        <span>启用账号</span>
      </label>
      <div class="assign-list">
        ${(state.admin.profiles || []).map((profile) => `
          <label class="assign-chip">
            <input type="checkbox" name="profile_ids" value="${profile.id}" ${(user?.profile_ids || []).includes(profile.id) ? "checked" : ""} />
            <span>${escapeHtml(profile.name)}</span>
          </label>
        `).join("")}
      </div>
      <div class="actions">
        <button class="btn primary" type="submit" ${state.busy ? "disabled" : ""}>${isExisting ? "保存用户" : "新增用户"}</button>
      </div>
    </form>
  `;
}

function adminRecordsView() {
  return `
    <section class="panel">
      <h2>全部取号批次</h2>
      ${batchTable(state.admin.records.batches || [], true)}
    </section>
    <section class="panel">
      <h2>账号明细</h2>
      ${recordTable(state.admin.records.records || [])}
    </section>
  `;
}

function canRestoreBatch(batch) {
  return (batch.remote_move_status || "").includes("已提交移动")
    && !batch.restore_status
    && Number(batch.issued_count || 0) > 0;
}

function shareText(batch) {
  if (!batch.share_url) return "";
  return `${batch.share_url}${batch.share_pwd ? ` 提取码: ${batch.share_pwd}` : ""}`;
}

function shareCell(batch) {
  const status = batch.share_status || "not_requested";
  if (status === "ok" && batch.share_url) {
    return `
      <div class="share-cell">
        <a class="btn tiny" href="${escapeHtml(batch.share_url)}" target="_blank" rel="noreferrer">打开</a>
        <button class="btn tiny ghost" type="button" data-copy-share="${escapeHtml(shareText(batch))}">复制</button>
        ${batch.share_pwd ? `<span class="muted">码 ${escapeHtml(batch.share_pwd)}</span>` : ""}
      </div>
    `;
  }
  if (status === "failed") {
    return `
      <div class="share-cell">
        <span class="muted">失败：${escapeHtml(batch.share_error || "分享失败")}</span>
        <button class="btn tiny" type="button" data-share-batch="${batch.id}">重试</button>
      </div>
    `;
  }
  if (status === "pending") return `<span class="muted">分享中</span>`;
  return `<button class="btn tiny" type="button" data-share-batch="${batch.id}">卡网分享</button>`;
}

function batchTable(rows, showUser) {
  return `
    <table>
      <thead>
        <tr>
          <th>时间</th>${showUser ? "<th>用户</th>" : ""}<th>Sub2API</th><th>数量</th><th>验活</th><th>处理</th><th>分享</th><th>挪回</th><th>下载</th>${showUser ? "<th>删除</th>" : ""}
        </tr>
      </thead>
      <tbody>
        ${(rows || []).map((batch) => `
          <tr>
            <td>${escapeHtml(fmtDate(batch.created_at))}</td>
            ${showUser ? `<td>${escapeHtml(batch.username || batch.created_by || "")}</td>` : ""}
            <td>${escapeHtml(batch.profile_name || "-")}</td>
            <td>${batch.issued_count}/${batch.requested_count}</td>
            <td>${escapeHtml(batch.validation_status || "")}</td>
            <td>${escapeHtml(batch.restore_status || batch.remote_move_status || "")}</td>
            <td>${shareCell(batch)}</td>
            <td>
              ${canRestoreBatch(batch)
                ? `<button class="btn tiny" type="button" data-restore-batch="${batch.id}">挪回</button>`
                : `<span class="muted">${batch.restore_status ? "已挪回" : "-"}</span>`}
            </td>
            <td><a class="btn tiny" href="/api/take/${batch.id}/download">下载</a></td>
            ${showUser ? `<td><button class="btn tiny danger" type="button" data-delete-batch="${batch.id}">删除</button></td>` : ""}
          </tr>
        `).join("") || `<tr><td colspan="${showUser ? 10 : 8}" class="muted">暂无记录</td></tr>`}
      </tbody>
    </table>
  `;
}

function recordTable(rows) {
  return `
    <table>
      <thead><tr><th>时间</th><th>用户</th><th>Sub2API</th><th>账号</th><th>平台</th><th>状态</th></tr></thead>
      <tbody>
        ${(rows || []).map((record) => `
          <tr>
            <td>${escapeHtml(fmtDate(record.created_at))}</td>
            <td>${escapeHtml(record.username || "")}</td>
            <td>${escapeHtml(record.profile_name || "")}</td>
            <td>${escapeHtml(record.account_name || "")}</td>
            <td>${escapeHtml(record.platform || "")}</td>
            <td>${escapeHtml(record.validation_status || record.status || "")}</td>
          </tr>
        `).join("") || `<tr><td colspan="6" class="muted">暂无记录</td></tr>`}
      </tbody>
    </table>
  `;
}

function render() {
  app.innerHTML = state.user ? shellView() : loginView();
  bindEvents();
}

function checkedValues(container, name) {
  return [...container.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => Number(input.value));
}

function profilePayload(form, profileId = "") {
  return {
    name: form.elements.name.value,
    base_url: form.elements.base_url.value,
    email: form.elements.email.value,
    password: form.elements.password.value,
    enabled: form.elements.enabled.checked,
    move_to_taken_group: form.elements.move_to_taken_group.checked,
    source_group_ids: profileId ? checkedValues(document, `source_group_ids_${profileId}`) : [],
    taken_group_ids: profileId ? checkedValues(document, `taken_group_ids_${profileId}`) : []
  };
}

function userPayloadFromForm(form) {
  return {
    username: form.elements.username.value,
    display_name: form.elements.display_name.value,
    password: form.elements.password.value,
    role: form.elements.role.value,
    enabled: form.elements.enabled.checked,
    profile_ids: checkedValues(form, "profile_ids")
  };
}

function pan123ConfigPayload(form) {
  const timeout = Number(form.elements.playwright_timeout_ms.value || 90000);
  const payload = {
    account: form.elements.account.value,
    login_method: form.elements.login_method.value === "playwright" ? "playwright" : "api",
    playwright_headless: Boolean(form.elements.playwright_headless.checked),
    playwright_timeout_ms: Number.isFinite(timeout) ? timeout : 90000
  };
  if (form.elements.password.value) payload.password = form.elements.password.value;
  return payload;
}

async function refreshAll() {
  await loadFront();
  if (state.user?.role === "admin") await loadAdmin();
}

function bindEvents() {
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.mode = button.dataset.mode;
      state.tab = state.mode === "admin" ? "adminHome" : "home";
      state.notice = "";
      state.error = "";
      await refreshAll();
      if (state.mode === "front" && state.tab === "take") await refreshTakeAvailabilityIfPossible();
      render();
    });
  });

  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.tab = button.dataset.tab;
      state.notice = "";
      state.error = "";
      if (state.mode === "admin") await loadAdmin();
      if (state.mode === "front") {
        await loadFront();
        if (state.tab === "take") await refreshTakeAvailabilityIfPossible();
      }
      render();
    });
  });

  document.getElementById("logout-button")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
    state.user = null;
    render();
  });

  document.getElementById("login-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const data = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: form.get("username"),
          password: form.get("password")
        })
      });
      state.user = data.user;
      state.mode = "front";
      state.tab = "home";
      await refreshAll();
      setMessage("");
    } catch (error) {
      setMessage("", error.message);
    }
  });

  document.getElementById("take-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = {
      profile_id: Number(form.get("profile_id")),
      count: Number(form.get("count")),
      validate: form.get("validate") === "on",
      delivery: form.get("delivery") || "download"
    };
    setBusy(true);
    try {
      const data = await api("/api/front/take", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      await loadFront();
      await refreshAvailability(payload.profile_id, { silent: true });
      if (!Number(data.issued_count || 0) || !data.download_url) {
        setMessage("", "当前取号分组没有可提取账号，已停止取号，不会生成下载文件");
        return;
      }
      const baseMessage = `取号完成：${data.issued_count}/${data.requested_count}\n${data.validation_message}\n${data.remote_move_status}`;
      if (payload.delivery === "kanwang_share") {
        if (data.share?.status === "ok") {
          state.notice = `${baseMessage}\n卡网分享：${data.share.message || `${data.share.url} 提取码: ${data.share.pwd || ""}`}`;
          state.error = "";
        } else {
          state.notice = baseMessage;
          state.error = `卡网分享失败：${data.share?.error || "请稍后在记录里重试"}`;
        }
        render();
        return;
      }
      state.notice = baseMessage;
      state.error = "";
      render();
      window.location.href = data.download_url;
    } catch (error) {
      setMessage("", error.message);
    } finally {
      setBusy(false);
    }
  });

  document.getElementById("validate-button")?.addEventListener("click", async () => {
    const form = document.getElementById("take-form");
    const payload = {
      profile_id: Number(form.elements.profile_id.value),
      count: Number(form.elements.count.value)
    };
    setBusy(true);
    try {
      const data = await api("/api/front/validate", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      setMessage(`${data.message}，本次处理 ${data.checked_count} 个账号。`);
    } catch (error) {
      setMessage("", error.message);
    } finally {
      setBusy(false);
    }
  });

  document.getElementById("profile-id")?.addEventListener("change", async (event) => {
    const profileId = Number(event.currentTarget.value);
    setBusy(true);
    try {
      await refreshAvailability(profileId, { silent: true });
      setMessage("");
    } catch (error) {
      setMessage("", error.message);
    } finally {
      setBusy(false);
    }
  });

  document.getElementById("refresh-availability")?.addEventListener("click", async () => {
    const profileId = currentTakeProfileId();
    setBusy(true);
    try {
      await refreshAvailability(profileId, { silent: true });
      setMessage("可提取数量（未验活）已刷新。");
    } catch (error) {
      setMessage("", error.message);
    } finally {
      setBusy(false);
    }
  });

  document.querySelectorAll("[data-restore-batch]").forEach((button) => {
    button.addEventListener("click", async () => {
      setBusy(true);
      try {
        const data = await api(`/api/take/${button.dataset.restoreBatch}/restore`, {
          method: "POST",
          body: "{}"
        });
        await refreshAll();
        let availabilityMessage = "";
        if (state.mode === "front") {
          try {
            await refreshTakeAvailabilityIfPossible();
          } catch (error) {
            availabilityMessage = `\n可提取数量刷新失败：${error.message}`;
          }
        }
        const validationMessage = data.validation_message ? `\n${data.validation_message}` : "";
        setMessage(`已挪回 ${data.restored_count} 个账号到原取号分组。${validationMessage}${availabilityMessage}`);
      } catch (error) {
        setMessage("", error.message);
      } finally {
        setBusy(false);
      }
    });
  });

  document.querySelectorAll("[data-share-batch]").forEach((button) => {
    button.addEventListener("click", async () => {
      setBusy(true);
      try {
        const data = await api(`/api/take/${button.dataset.shareBatch}/share`, {
          method: "POST",
          body: "{}"
        });
        await refreshAll();
        setMessage(`卡网分享已生成：${data.share.message || `${data.share.url || ""} 提取码: ${data.share.pwd || ""}`}`);
      } catch (error) {
        await refreshAll().catch(() => {});
        setMessage("", error.message);
      } finally {
        setBusy(false);
      }
    });
  });

  document.querySelectorAll("[data-copy-share]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await copyText(button.dataset.copyShare);
        setMessage("分享链接已复制。");
      } catch (error) {
        setMessage("", "复制失败，请手动复制分享链接。");
      }
    });
  });

  document.getElementById("pan123-config-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = pan123ConfigPayload(event.currentTarget);
    setBusy(true);
    try {
      const data = await api("/api/admin/pan123/config", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      state.admin.pan123 = data.status;
      setMessage("123 云盘登录配置已保存。");
    } catch (error) {
      setMessage("", error.message);
    } finally {
      setBusy(false);
    }
  });

  document.getElementById("pan123-login")?.addEventListener("click", async () => {
    const form = document.getElementById("pan123-config-form");
    const config = pan123ConfigPayload(form);
    setBusy(true);
    try {
      const data = await api("/api/admin/pan123/login", {
        method: "POST",
        body: JSON.stringify({
          method: config.login_method,
          config
        })
      });
      state.admin.pan123 = data.status;
      setMessage(`${config.login_method === "playwright" ? "Playwright" : "接口"}登录成功，卡网分享会继续复用这次 123 云盘登录状态。`);
    } catch (error) {
      setMessage("", error.message);
    } finally {
      setBusy(false);
    }
  });

  document.getElementById("pan123-refresh")?.addEventListener("click", async () => {
    setBusy(true);
    try {
      state.admin.pan123 = await api("/api/admin/pan123/status");
      setMessage("123 云盘状态已刷新。");
    } catch (error) {
      setMessage("", error.message);
    } finally {
      setBusy(false);
    }
  });

  document.getElementById("pan123-logout")?.addEventListener("click", async () => {
    setBusy(true);
    try {
      const data = await api("/api/admin/pan123/logout", { method: "POST", body: "{}" });
      state.admin.pan123 = data.status;
      setMessage("123 云盘登录状态已清除。");
    } catch (error) {
      setMessage("", error.message);
    } finally {
      setBusy(false);
    }
  });

  document.querySelectorAll("[data-delete-batch]").forEach((button) => {
    button.addEventListener("click", async () => {
      const batchId = button.dataset.deleteBatch;
      if (!window.confirm("确认删除这个取号批次吗？删除后本地批次和账号明细都会移除。")) return;
      setBusy(true);
      try {
        await api(`/api/admin/batches/${batchId}`, { method: "DELETE" });
        await refreshAll();
        setMessage("取号批次已删除。");
      } catch (error) {
        setMessage("", error.message);
      } finally {
        setBusy(false);
      }
    });
  });

  document.querySelectorAll(".profile-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const id = form.dataset.profileForm;
      const payload = profilePayload(form, id);
      setBusy(true);
      try {
        await api(id ? `/api/admin/profiles/${id}` : "/api/admin/profiles", {
          method: id ? "PUT" : "POST",
          body: JSON.stringify(payload)
        });
        await loadAdmin();
        setMessage(id ? "Sub2API 账号已保存。" : "Sub2API 账号已新增。");
      } catch (error) {
        setMessage("", error.message);
      } finally {
        setBusy(false);
      }
    });
  });

  document.querySelectorAll("[data-test-profile]").forEach((button) => {
    button.addEventListener("click", async () => {
      setBusy(true);
      try {
        const data = await api(`/api/admin/profiles/${button.dataset.testProfile}/test`, { method: "POST", body: "{}" });
        setMessage(`连接成功：${data.email}`);
      } catch (error) {
        setMessage("", error.message);
      } finally {
        setBusy(false);
      }
    });
  });

  document.querySelectorAll("[data-sync-profile]").forEach((button) => {
    button.addEventListener("click", async () => {
      setBusy(true);
      try {
        const data = await api(`/api/admin/profiles/${button.dataset.syncProfile}/sync-groups`, { method: "POST", body: "{}" });
        await loadAdmin();
        setMessage(`已同步 ${data.groups.length} 个分组。`);
      } catch (error) {
        setMessage("", error.message);
      } finally {
        setBusy(false);
      }
    });
  });

  document.querySelectorAll(".user-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const id = form.dataset.userForm;
      const payload = userPayloadFromForm(form);
      setBusy(true);
      try {
        await api(id ? `/api/admin/users/${id}` : "/api/admin/users", {
          method: id ? "PUT" : "POST",
          body: JSON.stringify(payload)
        });
        await refreshAll();
        setMessage(id ? "用户已保存。" : "用户已新增。");
      } catch (error) {
        setMessage("", error.message);
      } finally {
        setBusy(false);
      }
    });
  });
}

boot();
