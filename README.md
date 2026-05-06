<div align="center">
  <img src="logo.jpg" alt="白泽 Baize" width="120" style="border-radius: 24px" />

  <h1>白泽 · BaizeAI</h1>

  <p>
    一个专注跨境垂类、锤炼实战能力、护航落地创业的<br/>
    <b>跨境电商智能体平台</b>
  </p>

  <p>
    <a href="#-功能">功能</a> ·
    <a href="#-技术栈">技术栈</a> ·
    <a href="#-快速开始">快速开始</a> ·
    <a href="#-项目结构">项目结构</a> ·
    <a href="#-部署">部署</a> ·
    <a href="#-许可证">许可证</a>
  </p>

  <p>
    <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg" />
    <img alt="Node.js: 20+" src="https://img.shields.io/badge/node-20%2B-339933" />
    <img alt="No framework" src="https://img.shields.io/badge/frontend-vanilla%20HTML%2FCSS%2FJS-yellow" />
    <img alt="Backend: Fastify" src="https://img.shields.io/badge/backend-Fastify%20%2B%20SQLite-orange" />
  </p>
</div>

---

## 📖 简介

**白泽** 是一个面向跨境电商场景的多角色 AI 智能体平台，把"教师 / 学生 / 企业"三类用户的工作流串成一条闭环：

- **教师** 用 AI 备课、出题、评价；
- **学生** 跟着 AI 学技能、做项目、认领企业真实工单；
- **企业** 派发需求工单、查看人才档案、接入定制培训；
- **管理员** 在统一后台管账号、配 API、看用量、导数据。

智能体名为「**泽宝**」，所有对话由后端代理转发到任何 OpenAI 兼容的 LLM（默认接火山方舟豆包），API Key **永远不出后端**。

## ✨ 功能

### 🤖 多角色智能体
- **学生**：日程 / 能力图谱 / 技能 / 工单 / OPC 成长营 / 跨境知识库
- **教师**：能力图谱 / AI 课程 / AI 出题 / 学生作品 / AI 评价 / 学生成绩
- **企业**：AI 工具 / 工单派发 / 定制培训
- **跨境电商专家**（新会话）：通用对话入口，支持持久化多轮对话 + 历史会话恢复

### 🎨 图文混排
助手在回答中可插入 `[IMG: english prompt]` 标记，后端自动调用画图 API 生成图片并嵌入对话流——适合营销内容、风格情绪板、构图示意等需要视觉的场景。

### 📚 RAG 本地知识库
"产品合规分析"agent 内置本地文档库（docx → txt 自动抽取），用关键词 + n-gram 检索 Top-N 文档片段注入 prompt，用户感知不到来源元信息。

### 🌌 能力图谱可视化
全屏 SVG 知识地图：节点可拖动、滚轮缩放、双指捏合，布局通过后端持久化全平台共享，背景为 canvas 绘制的动态星空（含流星）。

### 👤 账号 / 角色 / 权限
- bcrypt 哈希密码 + JWT HttpOnly cookie（7 天有效）
- 注册：用户名 / 密码 / 角色 / 图形验证码
- 管理员后台：账号管理、API 配置（多份切换激活）、工单管理、用量统计、日志查看、数据导出（DB / CSV）、封禁解封

### 🛡️ 安全
- 前端**永远拿不到 API Key**（所有 LLM/画图请求由后端代发）
- 普通用户 F12 看不到任何敏感信息
- 用户被封禁后已签发的 cookie 立即失效（每次请求查 `blocked` 字段）
- 角色权限在后端中间件强校验，前端伪造无效

## 🏗️ 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| **前端** | 单文件 HTML + 原生 JS | 无任何框架，无构建步骤，3000+ 行覆盖全部 UI |
| **后端** | Node.js 20 + Fastify | 单文件 server.js，简洁高效 |
| **数据库** | SQLite（better-sqlite3） | 单文件落地，零运维 |
| **认证** | bcrypt + JWT cookie | HttpOnly + SameSite=Lax |
| **LLM 接入** | OpenAI 兼容 `/chat/completions` | 兼容 OpenAI / DeepSeek / 通义 / Kimi / 智谱 / 火山方舟 等 |
| **画图** | OpenAI 兼容 `/images/generations` | 兼容 OpenAI / 火山 Seedream（自动尺寸映射） |
| **文档抽取** | mammoth | docx → txt 用于 RAG |
| **反向代理** | nginx | 静态前端 + `/api/*` 代理到后端 |
| **进程管理** | systemd | 自动重启，原生稳定 |

## 🚀 快速开始

### 前置条件
- Node.js 20+
- npm 10+
- 一台 Linux/macOS 机器（开发或生产）

### 1. 克隆 + 装依赖

```bash
git clone git@github.com:hyyyyyyz/baizeai.git
cd baizeai/server
npm install
```

### 2. 启动后端

```bash
cd server
JWT_SECRET="$(openssl rand -base64 32)" \
DB_PATH="./data/baize.db" \
PORT=3000 \
node server.js
```

后端默认监听 `127.0.0.1:3000`，会自动建库 + 写入种子用户：

| 用户名 | 密码 | 角色 |
|---|---|---|
| `admin` | `1234567890` | 管理员（在登录页勾选「管理员」） |
| `xuesheng` | `1234567890` | 学生 |
| `jiaoshi` | `1234567890` | 教师 |
| `qiye` | `1234567890` | 企业 |

> ⚠️ 生产部署前请务必把代码里的 `SEED_ADMIN` 改掉，并把种子密码全部重置。

### 3. 启动前端

简易方式（开发用）：

```bash
# 在仓库根目录
python3 -m http.server 8000
# → 浏览器访问 http://localhost:8000
```

但这样前端没法访问后端 `/api/*`。生产推荐用 **nginx 反代**（见下文）。

### 4. 配置 LLM / 画图 API

浏览器登录管理员 → 侧边栏「**API 配置**」→ 填入：

- **大语言模型 API**（必填）
  - Base URL: `https://api.openai.com/v1` 或国内厂商兼容地址
  - API Key: 你的 Key
  - 模型: 例如 `gpt-4o-mini` / `deepseek-chat` / `doubao-seed-2-0-lite-260215`
- **AI 画图 API**（可选，用于"AI 产品做图"和图文混排）
  - Base URL: 同上
  - API Key: 同上
  - 模型: 例如 `dall-e-3` / `doubao-seedream-5-0-260128`

点「保存」+「测试连接」→ 绿色 ✓ 就能用了。所有用户对话都会自动走管理员配置的 API。

### 5. 加自己的合规知识库（可选）

```bash
# 把你的 .docx 文档放进任意名字的子目录
mkdir compliance-source
cp your-docs/*.docx compliance-source/

# 用脚本抽取为 txt
cd server
SRC_DIR=../compliance-source node extract-compliance.js

# 把 server/compliance/*.txt 上传到生产环境的
# /opt/baize-api/data/compliance/，重启后端即可生效
```

启动时后端日志会打印：`compliance loaded: N docs, M chars`

## 📁 项目结构

```
baizeai/
├── README.md                  # 你正在读的文件
├── LICENSE                    # MIT
├── .gitignore
├── .editorconfig
│
├── index.html                 # 前端单文件应用（3000+ 行）
├── logo.jpg                   # 品牌 Logo
│
├── server/                    # 后端
│   ├── package.json
│   ├── server.js              # Fastify 单文件后端
│   ├── extract-compliance.js  # docx → txt 抽取脚本
│   ├── .gitignore
│   └── data/                  # SQLite 数据库 + 用户数据（运行时生成，gitignored）
│       ├── baize.db
│       └── compliance/        # 合规 RAG 文本（你自己填充）
│
└── scripts/
    └── deploy.sh.example      # 一键部署模板（rsync + ssh）
```

## ☁️ 部署

### 推荐架构

```
浏览器
  │
  ├── /                → nginx → 静态文件 (/var/www/baize/)
  └── /api/*           → nginx 反向代理 → 127.0.0.1:3000 (Node 后端)
                                            │
                                            └── SQLite 数据库 + 调用 LLM/画图 API
```

### 步骤简述

1. **服务器**：任意支持 Node 20+ 的 Linux VPS（推荐 Ubuntu 22.04/24.04，2 核 2G 起）
2. **装环境**：
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
   apt install -y nodejs nginx
   ```
3. **后端落地** 到 `/opt/baize-api/`，systemd 启动：
   ```ini
   # /etc/systemd/system/baize-api.service
   [Service]
   ExecStart=/usr/bin/node /opt/baize-api/server.js
   EnvironmentFile=/etc/baize-api.env
   Restart=always
   ```
4. **nginx 配置**：详见 `scripts/deploy.sh.example` 顶部注释
5. **HTTPS**：`certbot --nginx -d yourdomain.com`
6. **一键发布前端更新**：`./deploy.sh`（拷贝模板自定义后）

> 国内域名访问 80/443 需要 ICP 备案；境外服务器或仅用 IP 访问可跳过备案。

## 🔧 自定义

### 加新的 chat agent
打开 `index.html`，在 `SKILL_AGENTS` / `OPC_AGENTS` / `OPC_SKILLS` / `TEACHER_AGENTS` 任一对象里加一项：

```js
'your-agent-id': {
  name: '你的助手名称',
  intro: '我是 <b>...</b>。我可以帮你...',
  placeholder: '提示用户该怎么问的示例文本',
}
```

### 修改泽宝的人格
后端 `server.js` 里搜 `buildExpertSystemPrompt` 函数 + chat 处理器中的 `sys` 变量。

### 新增管理员功能
后端按现有模式加 `app.<method>('/api/admin/...')` 路由（用 `requireUser(req, reply, 'admin')` 鉴权），前端在 `RENDERERS['admin:xxx']` 加渲染器，并在 `FEATURES.admin` 里挂入口。

## 🤝 参与贡献

欢迎 Issue 和 PR。任何能让"跨境电商 + AI"更易用的工具/agent/数据集都欢迎。

## 📜 许可证

[MIT License](LICENSE) — 自由使用、修改、分发、商用。

---

<div align="center">
  <sub>用 ❤️ 为跨境电商创业者打造</sub>
</div>
