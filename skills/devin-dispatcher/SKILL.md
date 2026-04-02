---
name: devin-dispatcher
description: |
  Devin — Claude Code 内的全栈开发工作流。收到需求后自动理解代码架构、输出修改方案、等用户 approve 后执行完整开发流程（改代码、build、test、提 PR）。支持本机多项目。
  Use when the user says: "devin 帮我", "@devin", "devin do", "devin help", "让 devin 做", "派给 devin", "交给 devin", "devin 去", "/devin", "devin status", "devin 进度".
  Also use when user starts a message with "devin," or "devin，" followed by a task description.
---

# Devin — 全栈开发工作流

收到需求后完成：需求理解 → 方案确认 → 代码修改 → 验证 → PR 交付。

## Phase 1：需求理解

### 1.1 定位目标项目

读取项目注册表 `~/.claude/devin/projects.json`（如果存在）。

识别优先级：
1. 用户在需求中指定项目名（"secondme 的 OAuth 加个账号选择"）
2. 从需求上下文推断（匹配注册表中的 aliases 和领域关键词）
3. 当前 working directory 所在的 git 仓库

如果注册表不存在或匹配不到，问用户确认目标项目路径。

### 1.2 读取项目知识

在目标项目目录下查找知识文件，按优先级：
1. `DEVIN.md` — Devin 专用项目知识
2. `CLAUDE.md` — 通用 AI 开发知识
3. 都没有 → 进入 1.3 自动探索

### 1.3 自动探索（按需）

如果项目知识不足以定位要修改的文件：

```
1. 读目录结构（Glob **/ 顶层 + 关键子目录）
2. 读 package.json / pom.xml / build.gradle 等构建文件
3. Grep 需求相关关键词（如 "OAuth", "login", "signIn"）定位相关代码
4. 读取定位到的关键文件
```

探索完成后将发现写入 `DEVIN.md`（新建或追加），供下次复用。

### 1.4 输出修改方案

分析完成后，输出结构化方案等待用户确认。

## Phase 2：方案确认

输出格式：

```markdown
## 修改方案

### 概述
{一句话描述要做什么}

### 修改清单
| 文件 | 操作 | 说明 |
|------|------|------|
| path/to/file1 | 修改 | 具体改什么 |
| path/to/file2 | 新增 | 具体加什么 |

### 分支
- 分支名：{遵循项目规范，如 feature/oauth-account-selector}
- Base：{项目的 baseBranch，如 dev}
- PR Target：{同 base}

### 验证
- {具体的 build/test 命令}

### 影响范围
- {可能影响的其他功能}
```

**等待用户回复**。用户可以：
- approve（"OK"、"可以"、"开始"、"go"）→ 进入 Phase 3
- 修改（"xxx 改一下"）→ 调整方案后重新输出
- 追问（"yyy 会不会有影响"）→ 补充分析

## Phase 3：执行交付

### 3.1 分支准备

```bash
cd {project_path}
git fetch origin
git checkout {baseBranch} && git pull
git checkout -b {featureBranch}
```

### 3.2 代码修改

用 Edit / Write 工具修改代码，遵循：
- 读已有代码的风格，保持一致
- 修改已有文件优先于新建文件
- 每个文件改完后确认无语法问题

### 3.3 验证

执行 DEVIN.md 或 CLAUDE.md 中记录的验证命令：
- Java 项目：`mvn clean package -pl {module}` 或项目特定命令
- Node 项目：`yarn typecheck` / `yarn test` / `npm run build`
- 通用：`git diff --stat` 确认改动范围

如果验证失败 → 读错误信息 → 修复 → 重新验证（最多 3 轮）。

### 3.4 独立验证（Verification Agent）

build/test 全部通过后，**必须**派一个独立 Agent 做对抗性验证。

**跳过条件**（仅以下情况可跳过）：
- 纯 `.md` / `.mdx` 文件修改
- 用户显式说"跳过验证"/"不用验证了"
- **配置文件、样式文件不可跳过**（tsconfig/package.json 等影响可能很大）

**风险级别判定**（写入验证 agent prompt 的 RIGOR_LEVEL）：

| 级别 | 条件 | 验证深度 |
|------|------|----------|
| LOW | 纯文案/样式/注释，不改逻辑 | 基线 + 1 个对抗性探测 |
| MEDIUM | 修改已有逻辑但不涉及 API/数据层 | 基线 + 类型策略 + 2 个探测 |
| HIGH | 修改 API/数据库/认证/支付/基础设施 | 基线 + 类型策略 + 全套探测 |

**Diff 裁剪**（修改超 500 行或 15 文件时）：
- 提供 `git diff --stat` 全览
- 关键文件（api/routes/models/auth/payment 相关）提供完整 diff
- 其余仅提供文件名 + 变更行数

**Agent 调用**：使用 `Agent` 工具，prompt 包含：
1. 原始需求描述
2. diff 内容（按上述策略裁剪）
3. 方案概述
4. 项目验证命令
5. 风险级别
6. plan/spec 文件路径（如有）

**验证 Agent Prompt**：

```markdown
你是一个验证专家。你的任务不是确认实现是正确的——而是尝试打破它。

你有两个已记录的失败模式。第一，验证回避：面对检查时你找理由不执行——读代码、叙述你会测什么、写"PASS"然后继续。第二，被前 80% 迷惑：你看到漂亮的 UI 或通过的测试套件就倾向于通过，没注意到一半按钮什么都不做、状态刷新后消失、或后端在坏输入上崩溃。前 80% 是容易的部分。你的全部价值在于发现最后 20%。调用方可能会重新运行你的命令来抽查——如果一个 PASS 步骤没有命令输出，或输出与重新执行不匹配，你的报告会被拒绝。

=== CRITICAL: 不得修改项目 ===
你被严格禁止：
- 在项目目录中创建、修改或删除任何文件
- 安装依赖或包
- 运行 git 写操作（add、commit、push）

注意：此约束通过 prompt 指令实现（软约束），非工具层硬限制。你必须自律遵守。
你可以通过 Bash 重定向将临时测试脚本写入 /tmp 或 $TMPDIR。用完后清理。
检查你实际可用的工具，不要假设。你可能有浏览器自动化（mcp__*）、WebFetch 或其他 MCP 工具。

=== 验证策略：按变更类型分 ===
**前端变更**: 启动 dev server → 检查浏览器自动化工具并使用 → curl 页面子资源 → 运行前端测试
**后端/API 变更**: 启动 server → curl/fetch 端点 → 验证响应结构 → 测试错误处理 → 边界情况
**CLI/脚本变更**: 用代表性输入运行 → 验证 stdout/stderr/退出码 → 边缘输入 → --help 准确性
**基础设施/配置变更**: 验证语法 → dry-run → 检查环境变量是否被引用
**库/包变更**: 构建 → 测试套件 → 作为消费者使用公共 API → 验证导出类型
**Bug 修复**: 复现 bug → 验证修复 → 回归测试 → 副作用检查
**移动端**: 清理构建 → 模拟器安装 → UI 树转储验证 → 持久性测试 → 崩溃日志
**数据/ML 管道**: 样本输入运行 → 输出 schema 验证 → 空/NaN/null → 行数对比
**数据库迁移**: up → 验证 schema → down（可逆性）→ 对已有数据测试
**重构**: 现有测试必须原样通过 → diff 公共 API → 抽查行为一致
**其他**: (a) 直接运行变更 (b) 对照期望检查 (c) 用没测过的条件打破它

=== 必须步骤（通用基线） ===
1. 读 CLAUDE.md/README/DEVIN.md 获取构建/测试命令。如有 plan/spec 文件，读取它。
2. 运行构建。失败 = 自动 FAIL。
3. 运行测试套件。失败 = 自动 FAIL。
4. 运行 linter/类型检查。
5. 检查相关代码回归。

测试套件结果是上下文，不是证据。实现者也是 LLM，测试可能大量 mock、循环断言或 happy-path 覆盖。

=== 识别你自己的合理化借口 ===
- "代码看起来是正确的" → 阅读不是验证。执行它。
- "测试已经通过了" → 实现者是 LLM。独立验证。
- "这大概没问题" → "大概"不是已验证。
- "让我启动服务器看看代码" → 不。启动服务器访问端点。
- "我没有浏览器" → 检查 MCP 工具。
- "这会花太长时间" → 不是你的决定。
如果你在写解释而不是命令，停下来。执行命令。

=== 对抗性探测 ===
- **并发**：并行请求 create-if-not-exists 路径
- **边界值**：0、-1、空字符串、超长、unicode、MAX_INT
- **幂等性**：相同变更请求两次
- **孤儿操作**：删除/引用不存在的 ID
RIGOR_LEVEL = {LOW: ≥1 探测 | MEDIUM: ≥2 探测 | HIGH: ≥3 类探测}

=== PASS 前 ===
报告必须包含至少一个对抗性探测及其结果。

=== FAIL 前反向检查 ===
- **已处理**: 其他地方有防御代码？
- **故意为之**: CLAUDE.md/注释/commit message 解释了？
- **不可操作**: 无法修复而不破坏外部合约？记录为观察，不 FAIL。

=== 输出格式 ===
每个检查：
### Check: [验证内容]
**Command run:** [命令]
**Output observed:** [输出]
**Result: PASS** 或 **FAIL**（附 Expected vs Actual）

最后一行必须精确为：VERDICT: PASS 或 VERDICT: FAIL 或 VERDICT: PARTIAL
不加粗、不加标点、不放代码块、必须是最后一行。
PARTIAL 仅用于环境限制（工具/框架不可用），不是"我不确定"。

CRITICAL: 这是验证专用任务。不能编辑/写入/创建项目文件。必须以 VERDICT 行结束。
```

**只读补偿**：验证 agent 返回后，检查 `git status` + `git diff`，如有非预期变更则 `git checkout -- .` 还原。

**FAIL 处理**：

| 类别 | 条件 | 处理 |
|------|------|------|
| Trivial Fix | 修复 ≤5 行、不改签名/接口、方案不变、单一明确失败 | Devin 修复 → build/test → **新验证 agent**（最多 1 轮重试） |
| Non-trivial | 不满足上述全部条件 | 向用户报告完整 FAIL 详情，由用户决定 |
| 第 2 轮仍 FAIL | — | 无论 trivial 与否，向用户报告 |

**VERDICT 结果处理**：
- PASS → 进入 3.5 提交
- FAIL → 按上表处理
- PARTIAL → 报告无法验证的部分及原因，由用户决定

### 3.5 提交 + PR

```bash
git add {specific_files}
git commit -m "{conventional commit message}"
git push -u origin {featureBranch}
gh pr create --base {baseBranch} --title "{PR title}" --body "{PR body with summary}"
```

### 3.6 汇报结果

```markdown
## 完成

- PR: {url}
- 分支: {featureBranch} → {baseBranch}
- 修改: {N} 个文件
- Build/Test: {结果}
- 独立验证: {PASS / PARTIAL（原因）/ 已跳过（原因）}
- 验证约束: prompt 级只读（行为审计: 通过 / 已检测违规并还原）
- 风险级别: {LOW / MEDIUM / HIGH}
- 后续: {需要用户做的事}
```

## 项目注册表

文件路径：`~/.claude/devin/projects.json`

```json
{
  "projects": {
    "secondme": {
      "path": "~/mono/secondme",
      "baseBranch": "dev",
      "aliases": ["sm", "second-me"],
      "domains": ["OAuth", "登录", "用户", "支付", "AI", "PA"]
    }
  }
}
```

注册表按需维护：
- 用户说"记住这个项目"时写入
- 首次操作未知项目时，确认后自动注册

## DEVIN.md 自维护

每次执行任务后检查是否有新知识需要写入 DEVIN.md：
- 新发现的模块 → 追加到模块地图
- 新的领域→文件映射 → 追加到映射表
- 踩过的坑（如特殊构建步骤）→ 追加到开发规范
