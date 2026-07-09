const { Pan123Client, Pan123Error, tokenFromPayload } = require("./pan123Client");

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function tokenFromUrl(value) {
  if (!value) return "";
  try {
    return new URL(String(value)).searchParams.get("token") || "";
  } catch {
    const match = String(value).match(/[?&]token=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }
}

function maskTokenInUrl(value) {
  return String(value || "").replace(/([?&]token=)[^&]+/g, "$1<redacted>");
}

function launchOptions(config = {}) {
  const options = {
    headless: config.headless === undefined
      ? parseBoolean(process.env.PAN123_PLAYWRIGHT_HEADLESS, process.env.NODE_ENV === "production")
      : Boolean(config.headless),
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  };
  if (config.executablePath || process.env.PAN123_PLAYWRIGHT_EXECUTABLE_PATH) {
    options.executablePath = config.executablePath || process.env.PAN123_PLAYWRIGHT_EXECUTABLE_PATH;
  } else if (config.channel || process.env.PAN123_PLAYWRIGHT_CHANNEL) {
    options.channel = config.channel || process.env.PAN123_PLAYWRIGHT_CHANNEL;
  } else if (process.platform === "win32") {
    options.channel = "chrome";
  }
  return options;
}

async function launchBrowser(chromium, config = {}) {
  const primary = launchOptions(config);
  try {
    return await chromium.launch(primary);
  } catch (error) {
    if (process.platform === "win32" && primary.channel === "chrome" && !process.env.PAN123_PLAYWRIGHT_CHANNEL) {
      try {
        return await chromium.launch({ ...primary, channel: "msedge" });
      } catch {
        throw error;
      }
    }
    throw error;
  }
}

async function firstUsable(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count().catch(() => 0)) return locator;
  }
  return null;
}

async function waitForFirstUsable(page, selectors, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const locator = await firstUsable(page, selectors);
    if (locator && await locator.isVisible().catch(() => false)) return locator;
    await page.waitForTimeout(500);
  }
  return firstUsable(page, selectors);
}

async function fillLoginForm(page, account, password) {
  const isPhone = /^1\d{10}$/.test(account);
  if (!isPhone) {
    await page.getByText("邮箱", { exact: true }).click({ timeout: 3000 }).catch(() => {});
  }

  const accountInput = await waitForFirstUsable(page, [
    'input[autocomplete="username"]',
    'input[placeholder*="手机号"]',
    'input[placeholder*="邮箱"]',
    'input[type="tel"]',
    'input[type="text"]'
  ]);
  if (!accountInput) throw new Pan123Error("123云盘网页登录页没有找到账号输入框", 502);
  await accountInput.fill(account);

  const passwordInput = await waitForFirstUsable(page, [
    "#basic_password",
    'input[autocomplete="current-password"]',
    'input[type="password"]'
  ]);
  if (!passwordInput) throw new Pan123Error("123云盘网页登录页没有找到密码输入框", 502);
  await passwordInput.fill(password);

  const loginButton = await firstUsable(page, [
    'button[type="submit"]',
    'button:has-text("登 录")',
    'button:has-text("登录")'
  ]);
  if (!loginButton) throw new Pan123Error("123云盘网页登录页没有找到登录按钮", 502);
  await loginButton.click();
}

async function tokenFromStorage(page) {
  return page.evaluate(() => {
    const values = [];
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        values.push(`${key || ""}=${storage.getItem(key) || ""}`);
      }
    }
    const joined = values.join("\n");
    const queryToken = joined.match(/[?&]token=([^&\s]+)/);
    if (queryToken) return decodeURIComponent(queryToken[1]);
    const jwt = joined.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    return jwt ? jwt[0] : "";
  }).catch(() => "");
}

async function waitForLoginToken(page, responseTokenRef, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const responseToken = responseTokenRef();
    if (responseToken) return responseToken;

    const urlToken = tokenFromUrl(page.url());
    if (urlToken) return urlToken;

    const storageToken = await tokenFromStorage(page);
    if (storageToken) return storageToken;

    await page.waitForTimeout(500);
  }
  return "";
}

function publicUserInfo(info) {
  if (!info || typeof info !== "object") return null;
  const maskPhone = (value) => String(value || "").replace(/^(\d{3})\d+(\d{4})$/, "$1****$2");
  return {
    uid: info.UID || info.uid || "",
    nickname: maskPhone(info.Nickname || info.nickname || ""),
    passport: maskPhone(info.Passport || info.passport || ""),
    mail: info.Mail || info.mail || "",
    file_count: info.FileCount ?? info.file_count ?? null,
    space_used: info.SpaceUsed ?? info.space_used ?? null,
    space_permanent: info.SpacePermanent ?? info.space_permanent ?? null
  };
}

async function loginPan123ByPlaywright(config = {}) {
  const account = String(config.account || process.env.PAN123_ACCOUNT || "").trim();
  const password = String(config.password || process.env.PAN123_PASSWORD || "");
  if (!account || !password) throw new Pan123Error("123云盘账号或密码未配置", 400);

  let playwright;
  try {
    playwright = require("playwright");
  } catch {
    throw new Pan123Error("服务端还没有安装 Playwright，无法执行 123云盘网页登录", 500);
  }

  const timeoutMs = Number(config.timeoutMs || process.env.PAN123_PLAYWRIGHT_TIMEOUT_MS || 90000);
  const loginUrl = config.loginUrl || process.env.PAN123_LOGIN_URL || "https://user.123pan.cn/centerlogin?redirect_url=https%3A%2F%2Fyun.123pan.cn%2F%3Fnotoken%3D1&source_page=other";
  const browser = await launchBrowser(playwright.chromium, config);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: process.env.PAN123_PLAYWRIGHT_USER_AGENT || undefined
  });
  const page = await context.newPage();
  let capturedToken = "";

  page.on("response", async (response) => {
    if (capturedToken || !response.url().includes("/api/user/sign_in")) return;
    const payload = await response.json().catch(() => null);
    const token = tokenFromPayload(payload);
    if (token) capturedToken = token;
  });

  try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.getByText("账号登录", { exact: true }).click({ timeout: 3000 }).catch(() => {});
    await fillLoginForm(page, account, password);
    const token = await waitForLoginToken(page, () => capturedToken, timeoutMs);
    if (!token) {
      throw new Pan123Error("Playwright 已提交 123云盘账密，但没有拿到登录 token；如果页面出现滑块、短信或风控，请处理后再重试", 502, {
        currentUrl: maskTokenInUrl(page.url())
      });
    }

    const loginUuid = process.env.PAN123_LOGIN_UUID || "";
    const client = new Pan123Client({
      token,
      loginUuid,
      apiBase: config.apiBase,
      userBase: config.userBase
    });
    const userInfo = await client.userInfo();
    return {
      token,
      loginUuid: client.loginUuid,
      userInfo,
      publicUser: publicUserInfo(userInfo),
      currentUrl: maskTokenInUrl(page.url())
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = {
  loginPan123ByPlaywright,
  publicUserInfo
};
