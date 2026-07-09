# Sub2API 取号平台

一个本地部署的 Sub2API 取号平台，使用 SQLite 保存用户、Sub2API 账号配置、分配关系和取号记录。

## 功能

- 前台用户登录取号
- 后台管理员单独配置
- 支持多个 Sub2API 账号
- 后台按用户分配可用的 Sub2API 账号
- 每个 Sub2API 账号可独立配置访问路径、账密、取号分组、已取号分组
- 未配置取号分组的 Sub2API 账号不会允许前台取号
- 如果开启“取号后移动到已取号分组”，取号记录里可一键挪回原取号分组
- 前台输入数量，批量验活，导出 Sub2API 原生账号 JSON
- 首页展示用户已取号数量、批次数、已分配账号
- 取号页展示当前取号分组下剩余账号数量
- 取号支持下载 JSON 或生成 123 云盘分享链接
- 后台按用户、按 Sub2API 账号统计取号数量
- 后台展示今日、总计、按天取号统计
- 管理员可删除取号批次和对应账号明细
- SQLite 持久化，Docker 部署

## 默认账号

前台用户：

```text
账号：user
密码：user123456
```

后台管理员：

```text
账号：admin
密码：admin123456
```

建议部署前修改 `docker-compose.yml` 里的密码和 `APP_SECRET`。

## Docker 部署

```bash
docker compose up -d --build
```

打开：

```text
http://localhost:8978
```

SQLite 数据会保存在项目的 `./data/app.db`，Docker 容器会把本地 `./data` 挂载到 `/data`，所以本地运行和 Docker 运行会看到同一份数据。

如果 Docker 页面内容和本地代码对不上，先强制重建镜像：

```bash
docker compose down
docker compose build --no-cache
docker compose up -d
```

也可以把当前 `.env` 直接打进镜像，然后不用 compose 启动：

```bash
docker build --no-cache -t sub2api-picker .
docker rm -f sub2api-picker
docker run -d --name sub2api-picker -p 8978:8978 -v "${PWD}/data:/data" sub2api-picker
```

注意：这种方式会把 `.env` 里的账号和密钥写入镜像，只适合自用或私有环境，不要把镜像推到公开仓库。

## 本地运行

```bash
npm install
npm start
```

常用环境变量：

```text
PORT=8978
DB_PATH=./data/app.db
APP_USERNAME=admin
APP_PASSWORD=admin123456
FRONT_USERNAME=user
FRONT_PASSWORD=user123456
APP_SECRET=change-this-to-a-long-random-string
SUB2API_URL=http://your-sub2api-host:8080
SUB2API_EMAIL=your@email.com
SUB2API_PASSWORD=your-password
PAN123_ACCOUNT=your-123pan-account
PAN123_PASSWORD=your-123pan-password
PAN123_TOKEN=
PAN123_COOKIE=
PAN123_LOGIN_UUID=
PAN123_PARENT_FILE_ID=0
PAN123_SHARE_DAYS=1
PAN123_LOGIN_METHOD=api
PAN123_PLAYWRIGHT_HEADLESS=false
PAN123_PLAYWRIGHT_CHANNEL=chrome
PAN123_PLAYWRIGHT_EXECUTABLE_PATH=
PAN123_PLAYWRIGHT_TIMEOUT_MS=90000
```

`PAN123_ACCOUNT` 和 `PAN123_PASSWORD` 用于 123 云盘登录。管理员进入“后台配置 / 123云盘”后，可以在后台选择“接口登录”或“Playwright 登录”，也可以切换 Playwright 无头模式；登录成功后会把凭证和用户信息保存到本地 SQLite，后续“卡网分享”会继续走接口自动复用。也可以改用 `PAN123_TOKEN` 或 `PAN123_COOKIE` 作为分享凭证。

## 使用流程

1. 使用后台管理员登录。
2. 如需使用“卡网分享”，进入“后台配置 / 123云盘”，选择登录方式并点击“按配置登录”完成 123 云盘登录。
3. 进入“后台配置 / Sub2API账号”，测试连接并同步分组。
4. 在每个 Sub2API 账号里勾选“取号分组”和“已取号分组”。
5. 进入“用户分配”，给前台用户分配一个或多个 Sub2API 账号。
6. 使用前台用户登录，进入“取号”，选择账号、输入数量、验活，并选择“下载 JSON”或“卡网分享”。
7. 如果账号未勾选取号分组，前台会禁止取号。
8. 取号页会展示当前取号分组剩余账号总数和各分组剩余数量。
9. 如果取号后移动到了已取号分组，可在取号记录里点击“挪回”恢复到原取号分组。
10. 后台记录页可删除取号批次；首页和后台首页会展示今日、总计、按天统计。
