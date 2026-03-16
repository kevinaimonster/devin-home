# Devin — 产品全貌文档

> 一个自主工作的 AI 软件工程师。在 GitHub Issue 里 @devin，它会独立完成从需求分析到代码部署的全部工作。

---

## 一、产品定位

Devin 不是对话机器人，是**执行者**。给它一个任务，它交付代码。

```
用户在 Issue 里写：@devin 做一个登录页面
                        ↓
Devin 自主完成：分析需求 → 设计方案 → 写代码 → 提 PR → 审查 → 合并 → 部署
                        ↓
用户收到：一个已 merge 的 PR + 完成报告
```

**核心价值**：人类只需提需求和验收，中间过程完全由 AI 自主完成。

---

## 二、系统架构

```
┌─────────────────────────────────────────────────────────┐
│                      GitHub                              │
│                                                          │
│  Issue (@devin)  ──webhook──→  Devin Server (Express)   │
│                                     │                    │
│  Issue Comments  ←──gh CLI──────────┤                    │
│  Pull Requests   ←──gh CLI──────────┤                    │
│  Branch/Commits  ←──gh API──────────┤                    │
│                                     │                    │
│                               ┌─────┴─────┐             │
│                               │  LLM API  │             │
│                               │ (DeepSeek)│             │
│                               └───────────┘             │
│                                                          │
│  Dashboard (Vercel) ←──GET /api/tasks──→ Devin Server   │
└─────────────────────────────────────────────────────────┘
```

### 组件清单

| 组件 | 技术 | 作用 |
|------|------|------|
| **Devin Server** | Express.js + TypeScript | Webhook 接收、Agent 决策循环、GitHub 操作 |
| **Dashboard** | Next.js 16 + Tailwind CSS | 任务监控面板 |
| **LLM** | DeepSeek API（OpenAI 兼容） | 需求分析、代码生成、代码审查 |
| **GitHub** | gh CLI + REST API | 代码托管、Issue/PR 管理 |
| **服务器** | 腾讯云 CVM + systemd | 运行 Devin Server |

---

## 三、核心文件

```
devin/
├── src/agent/
│   ├── server.ts          # 核心：webhook + agent loop + API（910 行）
│   └── run.ts             # GitHub Actions 备用入口
├── src/app/
│   ├── page.tsx           # Dashboard 首页（任务列表）
│   ├── tasks/[owner]/[repo]/[issue]/page.tsx  # 任务详情（对话时间线）
│   └── layout.tsx         # 深色主题布局
├── src/lib/
│   └── utils.ts           # 状态颜色、相对时间工具
├── docs/
│   ├── PRODUCT.md         # 本文档
│   └── DEVIN-CAPABILITIES.md  # 能力说明书
├── deploy.sh              # 一键部署脚本
├── .github/workflows/
│   └── devin.yml          # GitHub Actions 备用方案
├── prisma/
│   └── schema.prisma      # 数据库 Schema（未来扩展用）
└── .env.example           # 环境变量模板
```

---

## 四、Agent 工作原理

### 4.1 触发

用户在 GitHub Issue/PR 评论中包含 `@devin`，GitHub Webhook 发送事件到 Devin Server。

| 触发场景 | 示例 |
|---------|------|
| 新建 Issue | Issue body 含 `@devin 帮我做 X` |
| 评论 Issue | `@devin 请开始` |
| 评论 PR | `@devin 按 review 意见改` |
| 帮助 | `@devin --help` |

### 4.2 Agent Loop

Devin 的核心是一个**自主决策循环**，最多 15 轮：

```
for each iteration (max 15):
    1. 将对话历史发送给 LLM
    2. LLM 返回 JSON：{actions: [...], thinking: "...", done: true/false}
    3. 系统依次执行每个 action
    4. 将执行结果反馈给 LLM
    5. 如果 done=true，结束循环
```

LLM 在每轮可以执行多个 action，完全自主决定做什么：

| Action | 说明 |
|--------|------|
| `comment` | 在 Issue 发评论（汇报进度、提问） |
| `create_branch` | 创建 feature 分支 |
| `commit_file` | 提交单个文件（含代码校验） |
| `commit_files` | 提交多个文件 |
| `create_pr` | 创建 Pull Request |
| `review_pr` | LLM 驱动的结构化代码审查 |
| `merge_pr` | Squash merge + 删除分支 |
| `close_issue` | 关闭 Issue |
| `deploy_pages` | 部署到 GitHub Pages |
| `read_file` | 读取仓库文件 |
| `list_files` | 列出仓库文件 |
| `save_memory` | 保存经验到 `.devin/memory.md` |

### 4.3 典型执行流程

```
@devin 触发
  │
  ├─ 需求不清晰 → comment 提问 → done=true → 等用户回复
  │
  └─ 需求清晰 ↓
      │
      ├─ comment（汇报方案）
      ├─ create_branch
      ├─ commit_files（代码校验 → 提交）
      ├─ create_pr
      ├─ review_pr（LLM 审查：逻辑/语法/安全/风格）
      │   ├─ 发现问题 → 修复 → 重新提交 → 再审查
      │   └─ 审查通过 ↓
      ├─ merge_pr
      ├─ close_issue
      ├─ deploy_pages（如适用）
      ├─ save_memory（记录经验）
      └─ comment（完成报告：耗时/操作数/成功率）
```

### 4.4 安全机制

| 机制 | 说明 |
|------|------|
| **Webhook 签名验证** | HMAC-SHA256 验证请求来源 |
| **自触发过滤** | 过滤 Devin 自己的评论，防止无限循环 |
| **重复任务防护** | 同一 Issue 同时只处理一次 |
| **速率限制** | 同一 Issue 60 秒冷却 |
| **代码校验** | 提交前检查括号匹配、JSON 合法性、空文件 |
| **Markdown 清理** | 自动去除 LLM 输出中的代码块标记 |
| **迭代上限** | 最多 15 轮，用尽时通知用户 |
| **API 重试** | LLM 调用失败自动重试 3 次（指数退避） |
| **JSON 容错** | 多策略解析 LLM 输出，减少格式错误导致的失败 |
| **Agent 签名** | 每条评论带签名，区分人类和 AI |

---

## 五、智能能力

### 5.1 上下文感知

每次启动新任务时，Devin 自动收集：
- 仓库文件结构
- README.md 项目说明
- package.json / tsconfig.json 技术栈
- `.devin/memory.md` 跨 Issue 项目记忆
- `.devin/config.yml` 自定义配置（预留）

### 5.2 上下文压缩

对话超过 14 条消息时，自动总结旧消息，只保留关键成功信息和最近 8 条消息，防止 context 退化。

### 5.3 项目记忆

通过 `save_memory` action，Devin 可以将技术决策、踩过的坑、部署方式等写入 `.devin/memory.md`，下次接到同一项目的任务时自动加载。

### 5.4 两阶段生成

对复杂任务（3+ 文件或修改已有代码），Devin 先发布设计方案（文件清单、关键函数、数据流），再按方案逐个生成文件。

### 5.5 自我修复

`review_pr` 使用独立的 LLM 调用检查代码质量（逻辑错误、语法、安全、风格、边界处理）。发现问题后自动修改代码并重新提交，直到审查通过。

---

## 六、用户指令

| 指令 | 效果 |
|------|------|
| `@devin <需求>` | 执行任务 |
| `@devin --help` | 显示帮助信息 |
| `@devin --no-merge <需求>` | 只提 PR，不自动合并 |
| `@devin --draft <需求>` | 创建 Draft PR |
| `@devin --no-close <需求>` | 完成后不关闭 Issue |

---

## 七、Dashboard

**地址**：https://devin-blush.vercel.app

### 首页
- 统计栏：总任务 / 活跃 / 已完成
- 任务卡片列表：状态标签、仓库名、Issue 号、消息轮数、最后更新时间

### 任务详情
- 完整对话时间线（system / user / assistant）
- Assistant 消息中的 JSON actions 结构化展示
- Thinking 过程可视化
- GitHub Issue / PR 链接

### 数据来源
Dashboard 从 Devin Server 的 API 实时拉取数据：
- `GET /api/tasks` — 任务列表
- `GET /api/tasks/:owner/:repo/:issue` — 单个任务详情
- `GET /health` — 服务器状态

---

## 八、部署运维

### 8.1 基础设施

| 项目 | 详情 |
|------|------|
| 服务器 | 腾讯云硅谷 CVM (43.173.120.86) |
| 进程管理 | systemd (`devin.service`) |
| 日志 | `/var/log/devin.log`，logrotate 每日轮转保留 7 天 |
| 代码目录 | `/opt/devin-home` |
| 环境配置 | `/etc/devin.env` |
| Dashboard | Vercel (devin-blush.vercel.app) |
| Webhook | GitHub → http://43.173.120.86:3001/webhook |

### 8.2 一键部署

```bash
./deploy.sh
```

流程：push 到 GitHub → SSH 到服务器 → pull 代码 → 重启 systemd → 健康检查

### 8.3 环境变量

```bash
# /etc/devin.env
LLM_API_KEY=xxx          # LLM API 密钥
LLM_BASE_URL=https://api.deepseek.com  # LLM API 地址
LLM_MODEL=deepseek-chat  # 模型名称
PORT=3001                # 服务端口
```

### 8.4 systemd 服务

```ini
# /etc/systemd/system/devin.service
[Unit]
Description=Devin Agent Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/devin-home
EnvironmentFile=/etc/devin.env
ExecStart=npx tsx src/agent/server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- 崩溃后 5 秒自动重启
- 开机自动启动
- 日志输出到 `/var/log/devin.log`

### 8.5 监控

```bash
# 健康检查
curl http://43.173.120.86:3001/health

# 返回示例
{
  "status": "ok",
  "activeContexts": 5,
  "activeTasks": [],
  "queuedTasks": 0,
  "model": "deepseek-chat"
}

# 查看日志
ssh root@43.173.120.86 'tail -f /var/log/devin.log'

# 服务状态
ssh root@43.173.120.86 'systemctl status devin'
```

---

## 九、数据存储

### 9.1 对话上下文（当前）

文件系统 JSON，路径：`/root/devin-workspaces/.contexts/{owner}_{repo}_{issueNumber}.json`

每个文件是一个消息数组：
```json
[
  {"role": "system", "content": "你是 Devin..."},
  {"role": "user", "content": "Issue 标题：..."},
  {"role": "assistant", "content": "{\"actions\": [...]}"},
  {"role": "user", "content": "Action results: ..."}
]
```

### 9.2 项目记忆

仓库内 `.devin/memory.md`，跨 Issue 持久化。

### 9.3 数据库（预留）

Prisma Schema 已定义，包含 Task（状态机）、TaskLog（执行日志）、Installation（GitHub App 安装）三张表，接入 PostgreSQL 后可用于：
- 历史任务查询
- 统计分析（成功率、耗时趋势）
- 多用户隔离

---

## 十、双模式运行

### 模式 A：Webhook Server（主要）

```
GitHub Webhook → Express Server (43.173.120.86:3001)
             → DeepSeek API → GitHub API
```

- 优势：实时响应、会话持久化、任务队列、Dashboard
- 要求：一台在线的服务器

### 模式 B：GitHub Actions（备用）

```
GitHub Event → Actions Runner → Claude API → GitHub API
```

- 优势：零运维、GitHub 免费 runner
- 限制：无会话持久化、无 Dashboard、需要 API Key
- 触发：`.github/workflows/devin.yml`

---

## 十一、已验证的测试结果

| 测试场景 | Issue | PR | 结果 |
|---------|-------|-----|------|
| 新建单文件 | #6 | #7 merged | ✅ 全流程成功 |
| 新建多文件项目 | #1, #3 | #2, #4 merged | ✅ 全流程成功 |
| 修改已有文件 + 自我修复 | #8 | #9 merged | ✅ review 发现问题，自动修复 2 次后 merge |

---

## 十二、扩展路线

### 短期
- [ ] 创建独立 GitHub Bot 账号，替代共享个人账号
- [ ] 接入 Claude Code Agent SDK（OAuth 登录后），获得本地执行能力（跑测试、构建）
- [ ] Dashboard 加实时刷新和 WebSocket 推送

### 中期
- [ ] 接入 PostgreSQL，Dashboard 展示历史统计
- [ ] 多仓库支持（GitHub App 化，用户 install 即可）
- [ ] 沙盒预览环境（Vercel PR Preview / 临时容器）
- [ ] IM 通知（飞书 / Slack 推送关键节点）

### 长期
- [ ] 多模态输入（设计稿 → 代码）
- [ ] 跨仓库任务编排
- [ ] 自定义工作流（`.devin/config.yml`）
- [ ] 计费系统（按任务 / 按 token）
- [ ] 团队协作（多 Agent 并行，任务分配）

---

## 十三、快速开始

### 在现有仓库使用

1. 确保 Devin Server 在运行（`curl http://43.173.120.86:3001/health`）
2. 在仓库 Settings → Webhooks 添加 `http://43.173.120.86:3001/webhook`，事件选 `Issues` 和 `Issue comments`
3. 创建 Issue，body 里写 `@devin 你的需求`
4. 等待 Devin 完成工作

### 本地开发

```bash
git clone https://github.com/kevinaimonster/devin-home.git
cd devin-home
npm install

# Dashboard
npm run dev  # http://localhost:3000

# Server（需要配置 .env）
cp .env.example .env
# 填入 LLM_API_KEY
npx tsx src/agent/server.ts  # http://localhost:3001
```

### 部署到新服务器

```bash
# 1. 安装 Node.js + gh CLI
# 2. Clone 代码
git clone https://github.com/kevinaimonster/devin-home.git /opt/devin-home
cd /opt/devin-home && npm install

# 3. 配置环境
cat > /etc/devin.env << EOF
LLM_API_KEY=your-api-key
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
PORT=3001
EOF

# 4. 配置 gh CLI
gh auth login

# 5. 设置 systemd
# (复制 devin.service 到 /etc/systemd/system/)
systemctl enable devin && systemctl start devin

# 6. 配置 GitHub Webhook
# 指向 http://your-server:3001/webhook
```
