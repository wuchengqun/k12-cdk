const crypto = require("crypto");

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsnhu3abShvzh4gRWdHEK
BDzpZ1riNxyVxWbeNAWQQXPgSJ+Y6FXhj4zUcbzKrvvz1pUArEi3MFZHcHl7GO2E
YY2YecNOUkIuK5I6VsLR3Giz+tgevRMyTGssTZ54FU/HFP7I8pFpOMyuhRvi3aX4
Os+bZxzYhgExI+ZIA68BBw30Z4latsXxDi7DZktd9l8RSJkwWLnBJpsniSoc3nrd
6D6tmFKdfwMGFbcBdeAkw1P4XIe9eIkqyF+2HMAAKwnHREMIKAp1YhrtH8MKXhbf
wje0QTHsqoyWpQ+RBiHZNd1HYQ6ETTA/2tTRARTq+u0ol2H5uy/Tu/dH6+hEbSx+
gQIDAQAB
-----END PUBLIC KEY-----`;

class Pan123Error extends Error {
  constructor(message, statusCode = 502, detail = null) {
    super(message);
    this.name = "Pan123Error";
    this.statusCode = statusCode;
    this.detail = detail;
  }
}

function rsaEncrypt(value) {
  return crypto.publicEncrypt({
    key: PUBLIC_KEY,
    padding: crypto.constants.RSA_PKCS1_PADDING
  }, Buffer.from(String(value))).toString("base64");
}

function randomLoginUuid() {
  return crypto.randomBytes(32).toString("hex");
}

function randomSharePwd(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(length);
  let value = "";
  for (let index = 0; index < length; index += 1) value += chars[bytes[index] % chars.length];
  return value;
}

function shanghaiExpiration(days) {
  const target = new Date(Date.now() + Math.max(1, Number(days || 1)) * 24 * 60 * 60 * 1000 + 8 * 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return [
    `${target.getUTCFullYear()}-${pad(target.getUTCMonth() + 1)}-${pad(target.getUTCDate())}`,
    `${pad(target.getUTCHours())}:${pad(target.getUTCMinutes())}:${pad(target.getUTCSeconds())}+08:00`
  ].join("T");
}

function jsonHeaders(extra = {}) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json;charset=UTF-8",
    platform: "web",
    "App-Version": "132",
    ...extra
  };
}

function apiCacheBust() {
  return `${Math.floor(Date.now() / 1000)}-${crypto.randomInt(100000, 9999999)}-${crypto.randomInt(100000000, 429496729)}`;
}

function shareUrlFromPayload(share) {
  return share?.ShareUrl
    || share?.shareUrl
    || share?.share_url
    || share?.shareLinkList?.list?.[0]
    || share?.shareLinkList?.standBy
    || share?.shareLinkList?.standby
    || "";
}

function tokenFromPayload(payload) {
  const directToken = payload?.data?.token || payload?.token || payload?.data?.Token || payload?.Token;
  if (directToken) return String(directToken).trim();

  const redirectUrl = payload?.data?.redirect_url || payload?.data?.redirectUrl || payload?.redirect_url || payload?.redirectUrl;
  if (!redirectUrl) return "";
  try {
    return new URL(String(redirectUrl)).searchParams.get("token") || "";
  } catch {
    const match = String(redirectUrl).match(/[?&]token=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }
}

function cookieNames(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim().split("=")[0])
    .filter(Boolean);
}

function hasLoginCookie(cookieHeader) {
  return cookieNames(cookieHeader).some((name) => !["aliyungf_tc"].includes(name));
}

class Pan123Client {
  constructor(config = {}) {
    this.account = String(config.account || process.env.PAN123_ACCOUNT || "").trim();
    this.password = String(config.password || process.env.PAN123_PASSWORD || "");
    this.staticToken = String(Object.prototype.hasOwnProperty.call(config, "token") ? config.token : process.env.PAN123_TOKEN || "").trim();
    this.cookie = String(Object.prototype.hasOwnProperty.call(config, "cookie") ? config.cookie : process.env.PAN123_COOKIE || "").trim();
    this.hasConfiguredCookie = Boolean(this.cookie);
    this.userBase = String(config.userBase || process.env.PAN123_USER_BASE || "https://user.123pan.cn/api").replace(/\/+$/, "");
    this.apiBase = String(config.apiBase || process.env.PAN123_API_BASE || "https://api.123278.com/b/api").replace(/\/+$/, "");
    this.parentFileId = Number(config.parentFileId ?? process.env.PAN123_PARENT_FILE_ID ?? 0) || 0;
    this.shareDays = Number(config.shareDays || process.env.PAN123_SHARE_DAYS || 1);
    this.shareAppVersion = String(config.shareAppVersion || process.env.PAN123_SHARE_APP_VERSION || "3").trim();
    this.shareTrafficSwitch = Number(config.shareTrafficSwitch || process.env.PAN123_SHARE_TRAFFIC_SWITCH || 4);
    this.shareCacheParam = String(config.shareCacheParam || process.env.PAN123_SHARE_CACHE_PARAM || "373687248").trim();
    this.loginUuid = String(config.loginUuid || process.env.PAN123_LOGIN_UUID || randomLoginUuid()).trim();
    this.token = this.staticToken || null;
  }

  assertConfigured() {
    if (!this.account || !this.password) {
      throw new Pan123Error("123云盘账号或密码未配置", 400);
    }
  }

  async login() {
    this.assertConfigured();
    const isPhone = /^1\d{10}$/.test(this.account);
    const body = {
      ...(isPhone ? { passport: rsaEncrypt(this.account), type: 1 } : { mail: rsaEncrypt(this.account), type: 2 }),
      password: rsaEncrypt(this.password),
      remember: true,
      gray: true
    };
    const payload = await this.signIn(body);
    const token = tokenFromPayload(payload);
    if (token) {
      this.token = token;
      return token;
    }

    if (this.hasConfiguredCookie) return "";
    if (hasLoginCookie(this.cookie)) return "";
    throw new Pan123Error("123云盘接口直登没有返回可上传分享的凭证；请检查账号密码，或配置 PAN123_TOKEN / PAN123_COOKIE", 502, {
      code: payload.code,
      message: payload.message,
      dataKeys: payload.data && Object.keys(payload.data)
    });
  }

  async signIn(body) {
    const response = await fetch(`${this.userBase}/user/sign_in`, {
      method: "POST",
      headers: jsonHeaders({
        "app-version": "132",
        LoginUuid: this.loginUuid,
        Origin: "https://yun.123pan.cn",
        Referer: "https://yun.123pan.cn/"
      }),
      body: JSON.stringify(body)
    });
    this.rememberCookies(response);
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || ![0, 200].includes(payload.code)) {
      throw new Pan123Error(payload?.message || "123云盘登录失败", response.status || 502, payload);
    }
    return payload;
  }

  async ensureToken() {
    if (this.staticToken) {
      this.token = this.staticToken;
      return this.token;
    }
    if (this.hasConfiguredCookie) return "";
    if (!this.token) await this.login();
    return this.token;
  }

  rememberCookies(response) {
    const setCookie = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    if (!setCookie.length) return;
    const loginCookie = setCookie.map((item) => item.split(";")[0]).filter(Boolean).join("; ");
    if (loginCookie) this.cookie = this.cookie ? `${this.cookie}; ${loginCookie}` : loginCookie;
  }

  authHeaders(token) {
    return {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(this.cookie ? { Cookie: this.cookie } : {})
    };
  }

  async api(path, options = {}) {
    const { cacheParam, ...requestOptions } = options;
    const token = await this.ensureToken();
    const url = new URL(`${this.apiBase}/${path.replace(/^\/+/, "")}`);
    url.searchParams.set(cacheParam || process.env.PAN123_CACHE_PARAM || "4043287568", apiCacheBust());
    const response = await fetch(url, {
      ...requestOptions,
      headers: {
        ...jsonHeaders({
          LoginUuid: this.loginUuid,
          Origin: "https://yun.123pan.cn",
          Referer: "https://yun.123pan.cn/",
          ...this.authHeaders(token)
        }),
        ...(requestOptions.headers || {})
      }
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok || !payload || ![0, 200].includes(payload.code)) {
      throw new Pan123Error(payload?.message || `123云盘请求失败：${path}`, response.status || 502, payload);
    }
    return payload.data;
  }

  async post(path, body) {
    return this.api(path, { method: "POST", body: JSON.stringify(body || {}) });
  }

  async userInfo() {
    return this.api("user/info", { method: "GET" });
  }

  async uploadJson({ fileName, content }) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    const etag = crypto.createHash("md5").update(buffer).digest("hex");
    const upload = await this.post("file/upload_request", {
      driveId: 0,
      etag,
      fileName,
      parentFileId: this.parentFileId,
      size: buffer.length,
      type: 0,
      RequestSource: null
    });

    if (upload.Reuse && upload.Info?.FileId) {
      return { fileId: upload.Info.FileId, fileName, size: buffer.length, reused: true };
    }

    const auth = await this.post("file/s3_upload_object/auth", {
      bucket: upload.Bucket,
      key: upload.Key,
      partNumberEnd: 2,
      partNumberStart: 1,
      uploadId: upload.UploadId,
      StorageNode: upload.StorageNode
    });
    const putUrl = auth.presignedUrls?.["1"];
    if (!putUrl) throw new Pan123Error("123云盘上传授权缺少上传地址", 502, auth);

    const putResponse = await fetch(putUrl, { method: "PUT", body: buffer });
    if (!putResponse.ok) {
      throw new Pan123Error("123云盘文件上传失败", putResponse.status, await putResponse.text().catch(() => null));
    }

    const complete = await this.post("file/upload_complete/v2", {
      fileId: upload.FileId,
      bucket: upload.Bucket,
      fileSize: buffer.length,
      key: upload.Key,
      isMultipart: false,
      uploadId: upload.UploadId,
      StorageNode: upload.StorageNode
    });
    const fileId = complete.file_info?.FileId || upload.FileId;
    if (!fileId) throw new Pan123Error("123云盘上传完成但没有返回文件 ID", 502, complete);
    return { fileId, fileName, size: buffer.length, reused: false };
  }

  async createShare({ fileId, fileName }) {
    const sharePwd = randomSharePwd();
    const share = await this.api("share/create", {
      method: "POST",
      cacheParam: this.shareCacheParam,
      headers: {
        Accept: "*/*",
        "App-Version": this.shareAppVersion
      },
      body: JSON.stringify({
        driveId: 0,
        expiration: shanghaiExpiration(this.shareDays),
        fileIdList: Number(fileId),
        shareName: fileName,
        sharePwd,
        event: "shareCreate",
        fileNum: 1,
        renameVisible: false,
        shareModality: 1,
        operatePlace: 1,
        trafficLimitSwitch: 1,
        trafficLimit: 0,
        trafficSwitch: this.shareTrafficSwitch,
        fillPwdSwitch: 0
      })
    });
    const url = shareUrlFromPayload(share);
    if (!url) throw new Pan123Error("123云盘创建分享成功但没有返回链接", 502, share);
    return {
      url,
      pwd: sharePwd,
      message: `${url} 提取码: ${sharePwd}`,
      raw: share
    };
  }

  async uploadAndShare({ fileName, content }) {
    const uploaded = await this.uploadJson({ fileName, content });
    const shared = await this.createShare({ fileId: uploaded.fileId, fileName: uploaded.fileName });
    return { ...uploaded, ...shared };
  }
}

module.exports = {
  Pan123Client,
  Pan123Error,
  tokenFromPayload
};
