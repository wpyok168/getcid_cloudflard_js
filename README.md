# IID 激活服务 · Cloudflare Workers 版

基于 Cloudflare Workers + KV 存储实现的 IID 激活验证服务，支持日志管理、密码保护、UUID 精准删除、同 IID 筛选，解决分布式无状态环境下日志删除错乱问题。

## 版本说明
- worker1.js 无日志，cloudflare部署时无需设置KV、变量
- worker2.js 带日志（不建议部署使用）
- worker3.js 带日志 (每满 20 条 → 立即批量存 1 次;超过 5 分钟（300 秒）还没满 20 条 → 有数据就存，无数据不操作)（不建议部署使用）
- worker4.js 带日志 在works3.js 基础上优化kv操作，一键部署（worker.js）采用此脚本

## 🚀 快速部署

### 方式 1：一键部署（推荐）使用worker.js(即worker4.js)部署
[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wpyok168/getcid_cloudflard_js)

### 方式 2：手动部署
1. 登录 Cloudflare → Workers & Pages → 创建应用 → 创建 Worker
2. 编辑代码 → 粘贴 `worker.js`（带日志）或`worker1.js`（无日志）
3. 配置环境变量 `LOG_PASSWORD`
4. 绑定 KV 命名空间为 `KV_LOGS`
5. 保存并部署

## 🔗 访问地址
- 激活接口（POST）：`https://你的worker域名.workers.dev/`
- 日志面板：`https://你的worker域名.workers.dev/logs`



## 📋 目录

- [项目特性](#-项目特性)

- [环境要求](#-环境要求)

- [配置指南](#️-配置指南)

    - [环境变量配置](#31-环境变量配置必填可选)

    - [KV 命名空间配置](#32-KV-命名空间配置)

- [存储结构](#-存储结构)

- [路由说明](#-路由说明)

- [快速部署](#-快速部署)

- [安全说明](#-安全说明)

- [常见问题](#-常见问题)

## ✨ 项目特性

- ✅ **IID 激活验证**：调用官方接口完成 IID 验证，返回完整结果

- ✅ **UUID 精准删除**：解决 Cloudflare Workers 无状态环境下日志删除错乱问题

- ✅ **日志管理**：支持单条删除、清空所有、同 IID 筛选、分页展示

- ✅ **密码保护**：日志面板需密码登录，Cookie 有效期 1 天，保障安全

- ✅ **批量日志**：每 20 条或 5 分钟自动刷入 KV，提升性能

- ✅ **时区配置**：支持自定义时区偏移，日志时间显示更精准

- ✅ **跨域支持**：接口支持跨域访问，适配前端调用

## 📌 环境要求

- Cloudflare 账号（需开通 Workers 功能）

- Cloudflare KV 命名空间（用于存储日志）

- 基础 Workers 部署权限

## ⚙️ 配置指南

### 3.1 环境变量配置（必填+可选）

进入 Cloudflare Workers → 对应 Worker → **设置** → **环境变量**，添加以下变量：

|变量名|说明|默认值|是否必填|
|---|---|---|---|
|`LOG_PASSWORD`|日志面板 `/logs` 登录密码，建议设置复杂密码|-|✅ 是|
|`PAGE_SIZE`|日志列表每页显示条数，控制页面加载速度|`20`|❌ 可选|
|`TIMEZONE_OFFSET`|时区偏移量（东八区填 8，UTC 填 0，其他时区按实际填写）|`8`|❌ 可选|
示例配置：
`LOG_PASSWORD=YourStrongPassword123`
`PAGE_SIZE=30`
`TIMEZONE_OFFSET=8`

### 3.2 KV 命名空间配置

#### 3.2.1 创建 KV 命名空间

1. 进入 Cloudflare 控制台 → **Workers & Pages** → **KV**

2. 点击 **创建命名空间**，填写名称（如 `IID_LOGS`），点击创建

#### 3.2.2 绑定 KV 到 Worker

1. 进入对应 Worker → **设置** → **变量** → **KV 命名空间绑定**

2. 点击 **添加绑定**，填写：
        

    - 变量名称：`KV_LOGS`（**必须严格一致**，否则脚本无法读写日志）

    - 命名空间：选择刚才创建的 KV 命名空间

3. 点击保存，完成绑定

#### 3.2.3 脚本内 KV 相关常量（无需修改）

脚本中已固定以下常量，用于控制日志批量写入规则，无需手动修改：

```javascript
const KV_NAMESPACE = "KV_LOGS"; // 与绑定的变量名称一致
const BATCH_SIZE = 20;          // 每批次最大日志条数
const BATCH_FLUSH_SECONDS = 300;// 自动刷盘间隔（5分钟）
```

## 📊 存储结构

### 4.1 日志单条结构

每条日志自带唯一 UUID，用于精准删除，结构如下：

```javascript
{
  id: "crypto.randomUUID()",  // 唯一标识，用于删除（核心）
  time: "2026-04-01 12:00:00",// 格式化时间（按配置时区）
  IID: "xxxxxxxxx",           // 待验证的 IID
  ip: "1.2.3.4",              // 访问者 IP（cf-connecting-ip）
  result: {                   // 激活接口返回结果
    status: 200,              // 接口状态码
    success: true,            // 是否激活成功
    data: {}                  // 接口返回原始数据
  }
}
```

### 4.2 KV 存储格式

日志按批次存储在 KV 中，KV 键名格式为：

```Plain Text
batch_时间戳_UUID
```

示例：`batch_1712000000000_1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed`

每条 KV 存储一批日志（最多 20 条），达到数量或超时（5分钟）自动写入 KV。

## 🔗 路由说明

服务提供以下路由，适配不同功能场景：

|路径|请求方法|功能描述|访问权限|
|---|---|---|---|
|`/`|POST|IID 激活验证接口，接收 JSON 参数 `{ "IID": "xxx" }`|公开（无密码）|
|`/logs`|GET/POST|日志管理面板（GET 访问，POST 登录）|密码保护|
|`/logs/delete`|POST|单条日志删除，请求体为日志 UUID|密码保护|
|`/logs/clear`|POST|清空所有日志（不可恢复）|密码保护|
## 🚀 快速部署

1. 新建 Cloudflare Workers：进入 **Workers & Pages** → **创建应用** → **创建 Worker**，填写名称后部署（暂时部署空白 Worker）。

2. 替换脚本：进入 Worker → **编辑代码**，删除默认代码，粘贴项目完整脚本，保存。

3. 配置环境变量：按照 [3.1 节] 添加 `LOG_PASSWORD` 等变量。

4. 绑定 KV：按照 [3.2.2 节] 绑定 KV 命名空间。

5. 重新部署：点击 **部署**，部署完成后，访问 `https://你的Worker域名/logs`，输入密码登录日志面板。

## 🔒 安全说明

- 日志面板采用密码登录，Cookie 设为 `HttpOnly`、`SameSite=Lax`，有效期 1 天，防止 CSRF 和 XSS 攻击。

- 删除、清空日志接口均做密码校验，仅登录用户可操作。

- 所有日志存储在你自己的 Cloudflare KV 中，无外部数据传输，保障数据隐私。

- 建议设置复杂的 `LOG_PASSWORD`，避免弱密码被暴力破解。

## ❓ 常见问题

### Q1: 日志删除无效？

A: 项目已采用 UUID 精准删除，彻底解决序号偏移问题；进入日志页时会自动执行 `flushBatch`，确保内存中的日志全部写入 KV，刷新页面即可看到删除效果。

### Q2: KV 不生效，日志无法存储/读取？

A: 检查 KV 绑定名称必须为 `KV_LOGS`，且已正确绑定到当前 Worker；若仍有问题，可在 Cloudflare Workers 日志中查看报错信息。

### Q3: 日志时间显示错误？

A: 修改环境变量 `TIMEZONE_OFFSET`，东八区填 8，UTC 填 0，其他时区按实际偏移量填写（如东七区填 7）。

### Q4: 激活接口返回异常？

A: 检查脚本中 `sendActivationRequest` 函数的请求参数、请求头是否正确；若接口地址变更，需同步修改 `fetch` 地址。

## 📄 许可证

本项目采用 MIT 许可证开源，可自由修改、分发，使用时请保留原作者信息。

如果本项目对你有帮助，欢迎 Star 支持！

