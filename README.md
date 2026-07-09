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
http://localhost:3000
```

SQLite 数据会保存在 Docker volume `sub2api-picker-data` 中。

## 本地运行

```bash
npm install
npm start
```

常用环境变量：

```text
PORT=3000
DB_PATH=./data/app.db
APP_USERNAME=admin
APP_PASSWORD=admin123456
FRONT_USERNAME=user
FRONT_PASSWORD=user123456
APP_SECRET=change-this-to-a-long-random-string
SUB2API_URL=http://your-sub2api-host:8080
SUB2API_EMAIL=your@email.com
SUB2API_PASSWORD=your-password
```

## 使用流程

1. 使用后台管理员登录。
2. 进入“后台配置 / Sub2API账号”，测试连接并同步分组。
3. 在每个 Sub2API 账号里勾选“取号分组”和“已取号分组”。
4. 进入“用户分配”，给前台用户分配一个或多个 Sub2API 账号。
5. 使用前台用户登录，进入“取号”，选择账号、输入数量、验活并下载 JSON。
6. 如果账号未勾选取号分组，前台会禁止取号。
7. 取号页会展示当前取号分组剩余账号总数和各分组剩余数量。
8. 如果取号后移动到了已取号分组，可在取号记录里点击“挪回”恢复到原取号分组。
9. 后台记录页可删除取号批次；首页和后台首页会展示今日、总计、按天统计。
