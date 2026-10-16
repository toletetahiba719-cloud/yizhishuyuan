# 一纸书缘

面向校园读书活动的网页应用：投递阅读心得、随机拆信、浏览图书角，管理员审核和导出数据。支持约 300 人在数天至数周内分批参与，通过同一个 HTTPS 链接或微信二维码访问。

采用 **Node.js 原生 HTTP 后端 + HTML/CSS/JavaScript 前端**，没有第三方运行依赖。心得统一保存到服务器，**审核通过后才公开**。GitHub 保存项目代码；它不是已经上线的活动网站。

## 功能

- 投递昵称、书名、作者、20–2000 字心得及选填 QQ。
- 公开图书角、全文展开、随机拆信和联系方式复制。
- 管理员登录、审核、拒绝、重置、删除、搜索和 JSON 导出。
- 页面可见时每 30 秒同步数据，支持手动刷新和离线提示。
- 提交先持久保存再返回成功，备份恢复、内容去重和独立登录限流。
- Ubuntu 上通过 systemd 常驻运行，nginx 提供 HTTPS，自动备份与证书续期。

## 本地运行

推荐 **Node.js 24 LTS**，CI 验证 Node.js 22 / 24。

```bash
git clone https://github.com/toletetahiba719-cloud/yizhishuyuan.git
cd yizhishuyuan
npm ci --ignore-scripts
npm start
```

浏览器打开 **http://127.0.0.1:8080**。首次运行会自动建立 `data/notes.json`。本地默认管理员密码为 `admin888`，仅供开发使用；正式部署会生成独立随机密码，并拒绝默认或不足 16 位的密码。

自定义配置（Node.js 22/24 支持）：

```bash
# Windows PowerShell
Copy-Item .env.example .env
# macOS / Linux
cp .env.example .env

# 修改 .env 后运行；不要把真实密码提交到 GitHub
node --env-file=.env server.js
```

`npm start` 不自动读取 `.env`。直接双击 `index.html` 仅为本地演示，浏览器数据不能共享。

## 测试

```bash
npm test
```

测试自动使用临时目录，包含完整投递审核流程、中文分包、并发去重、鉴权、存储失败、恢复和负载测试，不会修改活动数据。更多验证结果见 [检查报告](docs/check-report.md)。

运行中的站点可做只读自检：

```bash
node smoke-test.js http://127.0.0.1:8080
```

## 公网部署

推荐一台 **2 核 2GB、Ubuntu 24.04、有公网 IP 的轻量服务器**和自有域名。公网通过 nginx 的 80/443 访问，Node 默认只监听回环。大陆节点按服务商要求办理备案；香港节点需要实测校园网络。上线后必须做微信扫码真机验证。

完整购买、Windows 上传、安装、HTTPS、二维码与备份步骤：[部署与运维教程](docs/deployment.md)。

**GitHub Pages 只能托管静态页面，无法运行这个 Node 后端，也无法共享持久数据。** 正式活动不要只发布 `index.html`。

## 目录

```text
.
├── index.html             # 前端页面与交互
├── server.js              # HTTP API、审核、鉴权与持久化
├── backup.js              # JSON 校验与每日备份
├── setup.sh               # Ubuntu 安装、systemd 与备份定时器
├── setup-https.sh         # nginx 与免费 HTTPS 证书
├── integration-test.js    # 后端完整流程与负载测试
├── frontend-test.js       # 前端交互回归测试
├── smoke-test.js           # 已运行站点的只读自检
├── loadtest.js             # 负载测试工具
├── .env.example           # 无真实密码的配置示例
├── .github/workflows/     # Linux / Windows 自动测试
├── docs/                  # 部署、检查报告与手机截图
└── data/                  # 运行时自动建立，不纳入 Git
```

## 数据与维护

数据保存在 `data/notes.json`，上一版与每日备份也位于 `data/`。整个数据目录、密码文件和本机设置均被 Git 忽略。上线数据应额外备份到电脑或异地，GitHub 源码备份不能代替活动数据备份。

当前按**单服务器、单 Node 进程**设计，不支持多个进程共同写同一份 JSON。未来长期运营或扩容时，应迁移到数据库与分页。昵称、心得和选填 QQ 在审核后公开，活动管理员应负责审核及撤回请求。

维护流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，敏感问题处理见 [SECURITY.md](SECURITY.md)。本仓库暂未授予开源许可证，保留现有权利。
