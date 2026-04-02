# SPEC-04 v2: 状态持久化与进度追踪

**优先级**: P1  
**来源**: SPEC-04（长任务状态持久化）+ SPEC-03（进度追踪）合并  
**影响范围**: SKILL.md 前 10 行 + Phase 3 全流程；CLAUDE.md 新增全局恢复规则  
**版本**: v2（2026-04-01）  
**前置依赖**: 无  

---

## 1. 问题陈述

devin-dispatcher 的任务周期长（修改多个文件、多轮 build/test 重试、验证 agent 交互），在执行过程中有两类中断场景：

### 1.1 主要场景：Session 中断恢复（高频）

- 用户关闭终端、网络断开、机器休眠
- Claude Code 进程被系统/用户 kill
- Session 超时自动断开

这些场景下，整个对话上下文丢失，Devin "完全失忆"。如果没有磁盘持久化，用户只能手动描述之前的进度，或从头开始。

### 1.2 次要场景：Context Compaction 后恢复（低频）

根据 Claude Code 源码分析（`src/services/compact/compact.ts`）：

- Compaction 后，Skill 内容会被重新注入，但有 **~5,000 tokens 上限**（`POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000`，约 20KB / 400-500 行 markdown）
- 当前 SKILL.md 约 183 行，**在上限内不会被截断**
- 但对话历史被压缩为摘要，具体的中间状态（当前 Phase、已修改文件列表、方案细节、分支名）**可能在摘要中丢失或不精确**
- Compaction 的摘要 prompt 会保留 "Pending Tasks" 和 "Current Work"，但格式为自然语言描述，不如结构化状态文件可靠

**结论**：compact 在典型 devin 任务中（183 行 SKILL.md）不会截断 skill 内容，但 session 中断是真实高频场景。状态文件的主要价值是 **session 中断后的精确恢复**，compact 后恢复是附带收益。

### 1.3 进度可见性问题

当前 Phase 3 执行阶段是黑盒：用户提交需求、approve 方案后，只能等到最终结果才知道发生了什么。对于复杂任务（可能执行 10-15 分钟），用户没有进度感知。

**设计原则**：进度追踪必须零额外工具调用。不使用 TaskCreate/TaskUpdate（18 次额外调用 overhead 不可接受），改为文本输出进度。状态文件作为 single source of truth，文本进度作为 UI 投影。

---

## 2. 状态文件机制

### 2.1 文件路径

```
{project_path}/.devin-state.json
```

单个文件，不按分支或任务 ID 分文件。如果检测到文件中的 `branch` 与当前任务不同分支，提示用户选择：继续之前的任务 or 覆盖开始新任务。

### 2.2 Schema

```json
{
  "version": 1,
  "task": "OAuth 登录添加账号选择功能",
  "phase": "executing",
  "branch": "feature/oauth-account-selector",
  "baseBranch": "release/stable",
  "projectPath": "/Users/xxx/mono/secondme",
  "projectName": "secondme",
  "plan": {
    "files": [
      {"path": "auth/oauth.ts", "action": "modify", "desc": "添加账号选择逻辑"},
      {"path": "components/OAuthDialog.tsx", "action": "create", "desc": "添加选择 UI"}
    ],
    "completed": ["auth/oauth.ts"],
    "pending": ["components/OAuthDialog.tsx"]
  },
  "buildCmd": "yarn build",
  "testCmd": "yarn test --related",
  "verifyStatus": null,
  "prUrl": null,
  "retryCount": 0,
  "lastError": null,
  "startedAt": "2026-04-01T10:00:00Z",
  "updatedAt": "2026-04-01T10:15:00Z"
}
```

#### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | number | Schema 版本，当前为 1，用于未来兼容 |
| `task` | string | 任务描述（来自 Phase 2 方案的概述） |
| `phase` | enum | `"initializing"` / `"executing"` / `"verifying"` / `"submitting"` / `"done"` |
| `branch` | string | 当前工作分支名 |
| `baseBranch` | string | PR 的 base 分支（来自 projects.json） |
| `projectPath` | string | 项目绝对路径 |
| `projectName` | string | 项目在 projects.json 中的 key |
| `plan.files` | array | 所有计划修改的文件及其操作类型 |
| `plan.completed` | string[] | 已完成修改的文件路径 |
| `plan.pending` | string[] | 待修改的文件路径 |
| `buildCmd` | string\|null | 构建验证命令 |
| `testCmd` | string\|null | 测试验证命令 |
| `verifyStatus` | null\|"PASS"\|"FAIL"\|"PARTIAL" | 独立验证结果 |
| `prUrl` | string\|null | PR 创建后的 URL |
| `retryCount` | number | 当前 phase 内的重试次数（build/test 失败重试） |
| `lastError` | string\|null | 最近一次错误信息（build 失败输出、test 失败信息等），截取前 500 字符 |
| `startedAt` | string | 任务开始时间（ISO 8601） |
| `updatedAt` | string | 最后更新时间（ISO 8601） |

### 2.3 写入时机（仅 4 个关键节点）

减少写入频率，只在 phase 变迁时写入，避免每改一个文件就写一次：

| 节点 | phase 值 | 写入内容 |
|------|----------|----------|
| **1. 初始化**：分支创建完成，准备开始改代码 | `"initializing"` → `"executing"` | 初始化全部字段：task, branch, baseBranch, plan（全部 pending）, projectPath, projectName |
| **2. 所有文件改完**：代码修改阶段结束，准备验证 | `"executing"` → `"verifying"` | 更新 plan.completed/pending（全部 completed），更新 updatedAt |
| **3. 验证通过**：build + test + 独立验证均通过 | `"verifying"` → `"submitting"` | 更新 verifyStatus, retryCount, lastError（清空或保留最后错误），updatedAt |
| **4. PR 创建完成** | `"submitting"` → `"done"` | 更新 prUrl, updatedAt, phase = "done" |

**注意**：
- 不在任务完成时删除状态文件。设置 `phase: "done"` 标记完成。
- 下次用户交互时（触发 `/devin`），如果检测到 `phase: "done"` 的状态文件，输出一行"上次任务已完成（PR: {url}）"后删除状态文件。
- 验证失败重试时，更新 `retryCount` 和 `lastError`，但不变更 phase。只有在验证最终通过/确认跳过后才迁移 phase。

### 2.4 写入实现

使用 `Write` 工具写入 JSON 文件。写入失败（权限问题等）不阻塞主流程，仅在文本输出中提示 `[WARN] 状态文件写入失败，恢复能力不可用`。

### 2.5 .gitignore 处理

在初始化阶段写入状态文件前，检查 `.gitignore` 是否已包含 `.devin-state.json`。如果没有，追加：

```bash
# 检查并追加（幂等）
grep -qxF '.devin-state.json' .gitignore 2>/dev/null || echo '.devin-state.json' >> .gitignore
```

---

## 3. 恢复机制

### 3.1 恢复触发点

恢复检查发生在两个位置，确保无论 skill 是否被截断都能触发：

#### 位置 1：CLAUDE.md 全局规则（不受 compact 影响）

在 `~/.claude/CLAUDE.md` 中添加：

```markdown
## Devin 恢复规则

每次触发 `/devin` 时，**在任何操作之前**先执行恢复检查：
1. 如果用户消息中能识别出目标项目路径（或从 `~/.claude/devin/projects.json` 匹配），检查 `{project_path}/.devin-state.json` 是否存在
2. 如果存在且 `phase != "done"`，进入恢复流程（见 SKILL.md 恢复逻辑）
3. 如果存在且 `phase == "done"`，输出上次任务完成信息后删除文件，然后正常处理新需求
4. 如果不存在，正常处理新需求
```

**设计理由**：CLAUDE.md 是 Claude Code 的全局指令，在每次对话开始时完整加载，不受 compact 截断影响。这确保了即使 SKILL.md 被截断，恢复检查仍然能被触发。

#### 位置 2：SKILL.md 前 10 行

在 SKILL.md 的 frontmatter 后、第一个 Phase 之前，添加恢复检查指令（确保在 compact 截断的安全区域内）：

```markdown
<!-- 恢复检查（必须在文件最前面，compact 截断安全区） -->
**启动检查**：执行任何 Phase 之前，先检查目标项目的 `{project_path}/.devin-state.json`。
如果存在未完成任务（`phase != "done"`），进入恢复流程而非从 Phase 1 开始。
恢复流程见下方"恢复逻辑"节。
```

### 3.2 恢复逻辑

检测到 `.devin-state.json` 且 `phase != "done"` 时：

```
1. 读取状态文件，提取 branch, phase, plan, lastError
2. 输出恢复信息：
   "[恢复] 检测到未完成任务: {task}"
   "[恢复] 分支: {branch}, 阶段: {phase}, 已完成: {completed.length}/{files.length} 个文件"
3. 切换到对应分支：git checkout {branch}
4. 用 git diff --stat {baseBranch}...{branch} 验证实际代码状态
5. 将 git diff 结果与 plan.completed 对比：
   - 如果一致 → 从对应 phase 继续
   - 如果 diff 中有文件不在 plan 中 → 提示用户确认（可能是手动改动）
   - 如果 plan.completed 中的文件在 diff 中没有变化 → 标记为需重做
6. 根据 phase 决定恢复入口：
   - "initializing" → 从 Phase 3.2（代码修改）开始
   - "executing" → 检查 plan.pending，继续修改未完成的文件
   - "verifying" → 重新运行 build/test 验证
   - "submitting" → 检查 PR 是否已创建（gh pr list --head {branch}），未创建则创建
```

### 3.3 中间状态恢复策略

| 中断场景 | 恢复策略 |
|----------|----------|
| 文件修改到一半（phase=executing） | `git diff` 检查文件状态。如果文件有 partial 修改（语法不完整），`git checkout -- {file}` 重置后重做该文件 |
| Build 失败修复中（phase=verifying, retryCount>0） | 读取 `lastError`，重新尝试修复。如果 retryCount >= 3，提示用户介入 |
| 验证 agent 运行中（phase=verifying） | 重新触发验证 agent |
| PR 创建中（phase=submitting） | 用 `gh pr list --head {branch}` 检查是否已创建。如已创建，更新 prUrl 并设 phase=done |

### 3.4 并发冲突处理

单个 `.devin-state.json` 文件，检测到属于不同分支时的处理：

```
读取状态文件 → 如果 state.branch != 当前任务的目标分支：
  输出：
  "[冲突] 检测到进行中的任务:"
  "  任务: {state.task}"
  "  分支: {state.branch}"
  "  阶段: {state.phase}"
  "  开始于: {state.startedAt}"
  ""
  "请选择:"
  "  1. 继续之前的任务"
  "  2. 放弃之前的任务，开始新任务"
  → 等待用户回复
```

如果用户选择放弃，覆盖状态文件并开始新任务。

---

## 4. 进度追踪

### 4.1 设计原则

- **零额外工具调用**：不使用 TaskCreate/TaskUpdate
- **文本输出即进度**：在每个关键步骤的开始和结束时，输出一行标准格式的进度信息
- **状态文件是 single source of truth**：文本进度是 UI 投影，不是独立的数据源

### 4.2 进度输出格式

在 Phase 3 执行过程中，按以下格式输出进度信息：

```
[devin] ---- 步骤 {n}/{total}: {步骤名} ----

... 正常的工具调用和操作 ...

[devin] ✓ 步骤 {n}/{total}: {步骤名} 完成
```

失败时：
```
[devin] ✗ 步骤 {n}/{total}: {步骤名} 失败 — {简要原因}
[devin] ↻ 重试 ({retryCount}/3)...
```

### 4.3 步骤映射

Phase 3 的步骤固定为以下序列（根据实际方案可能跳过某些步骤）：

| 步骤 | 名称 | 说明 |
|------|------|------|
| 1 | 分支准备 | checkout baseBranch, 创建 feature 分支 |
| 2 | 代码修改 | 修改 plan 中的所有文件（作为一个整体步骤，不拆分到文件级别以减少噪音） |
| 3 | Build 验证 | 运行 buildCmd |
| 4 | Test 验证 | 运行 testCmd |
| 5 | 独立验证 | Verification Agent（如果需要） |
| 6 | 提交 + PR | commit, push, gh pr create |

**实际示例**：

```
[devin] ---- 步骤 1/6: 分支准备 ----
... git checkout, git checkout -b ...
[devin] ✓ 步骤 1/6: 分支准备 完成

[devin] ---- 步骤 2/6: 代码修改 ----
... Edit auth/oauth.ts ...
... Edit components/OAuthDialog.tsx ...
[devin] ✓ 步骤 2/6: 代码修改 完成 (2 个文件)

[devin] ---- 步骤 3/6: Build 验证 ----
... yarn build ...
[devin] ✗ 步骤 3/6: Build 验证 失败 — Type error in OAuthDialog.tsx:42
[devin] ↻ 重试 (1/3)...
... 修复 type error ...
... yarn build ...
[devin] ✓ 步骤 3/6: Build 验证 完成 (重试 1 次)

[devin] ---- 步骤 4/6: Test 验证 ----
... yarn test --related ...
[devin] ✓ 步骤 4/6: Test 验证 完成

[devin] ---- 步骤 5/6: 独立验证 ----
... Verification Agent ...
[devin] ✓ 步骤 5/6: 独立验证 完成 — PASS

[devin] ---- 步骤 6/6: 提交 + PR ----
... git commit, git push, gh pr create ...
[devin] ✓ 步骤 6/6: 提交 + PR 完成
```

### 4.4 进度与状态文件的关系

进度文本是状态文件的 UI 投影。写入状态文件的 4 个节点与进度步骤的对应关系：

| 状态文件写入节点 | 对应进度步骤 |
|-----------------|-------------|
| 初始化（分支创建完成） | 步骤 1 完成后 |
| 所有文件改完 | 步骤 2 完成后 |
| 验证通过 | 步骤 3/4/5 全部完成后 |
| PR 创建完成 | 步骤 6 完成后 |

---

## 5. 对 SKILL.md 的具体修改

### 5.1 SKILL.md 头部添加恢复检查（frontmatter 之后的前 10 行内）

在 frontmatter `---` 之后、`# Devin` 标题之前插入：

```markdown
> **启动检查**：执行任何 Phase 之前，先检查目标项目的 `{project_path}/.devin-state.json`。
> 如果存在未完成任务（`phase != "done"`），进入恢复流程而非从 Phase 1 开始。
> 如果存在 `phase == "done"` 的已完成任务，输出完成信息后删除文件。
```

### 5.2 Phase 3 开头添加状态初始化 + 进度追踪

在 Phase 3 的 `### 3.1 分支准备` 之前添加：

```markdown
### 3.0 恢复检查 + 状态初始化

**恢复检查**：
1. 检查 `{project_path}/.devin-state.json` 是否存在
2. 如果存在且 `phase != "done"`，按恢复逻辑（见 SPEC-04 v2 3.2 节）跳转到对应步骤
3. 如果不存在，继续正常流程

**状态初始化**（3.1 分支准备完成后立即执行）：
- 确保 `.devin-state.json` 已加入 `.gitignore`
- 写入初始状态文件（phase = "executing"）

**进度输出**：
- Phase 3 的每个步骤开始时输出 `[devin] ---- 步骤 {n}/{total}: {名称} ----`
- 每个步骤结束时输出 `[devin] ✓ 步骤 {n}/{total}: {名称} 完成`
```

### 5.3 Phase 3 各子步骤的状态更新提示

在以下位置添加状态文件更新提示：

- **3.2 代码修改** 结尾：`所有文件修改完成后，更新状态文件：phase → "verifying"，plan.completed 更新`
- **3.3 验证** 结尾：`验证全部通过后，更新状态文件：phase → "submitting"，verifyStatus 更新`
- **3.4 提交 + PR** 结尾：`PR 创建完成后，更新状态文件：phase → "done"，prUrl 更新`

### 5.4 SKILL.md 结构优化

确保核心工作流定义在文件前半部分（compact 截断安全区内）：

- **前 20 行**：恢复检查指令 + Phase 定义概述
- **前 100 行**：Phase 1-3 核心流程
- **100 行以后**：项目注册表 schema、DEVIN.md 自维护规则、模板示例

当前 SKILL.md 183 行，在 5K token 限制内，结构已基本合理。

### 5.5 对 CLAUDE.md 的修改

在 `~/.claude/CLAUDE.md` 中添加以下规则：

```markdown
## Devin 任务恢复

每次触发 `/devin` 时，在 Phase 1 之前先检查：
1. 从用户消息或 `~/.claude/devin/projects.json` 识别目标项目路径
2. 检查 `{project_path}/.devin-state.json`
3. 如果存在且 `phase != "done"` → 读取文件，输出恢复信息，跳转到对应 phase 继续
4. 如果存在且 `phase == "done"` → 输出 "上次任务已完成（PR: {prUrl}）"，删除文件
5. 如果不存在 → 正常从 Phase 1 开始
```

---

## 6. 边界条件与风险

| 风险 | 应对 |
|------|------|
| 状态文件与实际代码状态不同步（用户手动改了文件） | 恢复时用 `git diff --stat {baseBranch}...{branch}` 验证实际修改，与 plan.completed 对比 |
| 多任务并发操作同一项目 | 单个 `.devin-state.json`，检测到分支不同时提示用户选择 |
| 状态文件写入失败（权限问题） | 不阻塞主流程，输出 `[WARN] 状态文件写入失败` |
| `.devin-state.json` 被 git 跟踪 | 初始化阶段自动追加到 `.gitignore`（幂等操作） |
| 文件修改到一半被中断 | 恢复时 `git diff` 检查文件完整性，partial 修改则 `git checkout -- {file}` 重置后重做 |
| Build/test 失败修复中被中断 | 读取 `lastError` + `retryCount`，继续修复。retryCount >= 3 时提示用户 |
| Session 重启但 compact 未发生 | 同样的恢复逻辑适用（恢复逻辑不依赖 compact） |
| 状态文件 schema 升级 | `version` 字段用于兼容性检查，不兼容时提示用户删除旧状态文件 |
| 进度输出被 compact 压缩 | 无影响——进度输出仅服务于用户实时观看，不作为恢复依据。恢复依赖状态文件 |

---

## 7. 验收标准

### 7.1 状态持久化

1. Phase 3 执行过程中，`.devin-state.json` 在 4 个关键节点正确更新
2. 模拟 session 中断后（新的对话），能正确恢复到上次断点继续执行
3. 恢复时 `git diff --stat` 验证与状态文件一致
4. 任务完成后 `phase` 设为 `"done"`，下次交互时清理
5. 状态文件不被 git 跟踪
6. 分支冲突时正确提示用户选择

### 7.2 进度追踪

1. Phase 3 每个步骤有清晰的开始/结束标记
2. 失败重试时有明确的失败原因和重试计数
3. 零额外工具调用（仅文本输出）
4. 进度格式统一，用户可一目了然看到当前进度

### 7.3 恢复触发

1. CLAUDE.md 中的全局规则在新 session 中正确触发恢复检查
2. SKILL.md 前 10 行的恢复指令在 compact 后仍然可见
3. 两个触发点不会导致重复恢复操作（状态文件读取是幂等的）

---

## 8. 与其他 SPEC 的关系

| SPEC | 关系 |
|------|------|
| SPEC-01（验证 Agent） | 状态文件记录 `verifyStatus`，恢复时重新触发验证 agent |
| SPEC-03（进度追踪） | **已合并到本 SPEC**。SPEC-03 作废 |
| SPEC-05（智能重试） | `retryCount` 和 `lastError` 可供 SPEC-05 的重试策略参考 |
| SPEC-06（结构化 DEVIN.md） | 无直接依赖，但 DEVIN.md 中的项目知识有助于恢复后的上下文重建 |

---

## 附录 A：Compact 机制源码关键发现

以下为 Claude Code compact 机制的关键参数，供设计决策参考：

```
POST_COMPACT_MAX_TOKENS_PER_SKILL = 5,000   // 每个 skill 截断上限
POST_COMPACT_SKILLS_TOKEN_BUDGET  = 25,000   // 所有 skill 总预算
POST_COMPACT_MAX_TOKENS_PER_FILE  = 5,000    // 每个文件恢复上限
POST_COMPACT_TOKEN_BUDGET         = 50,000   // 文件恢复总预算
POST_COMPACT_MAX_FILES_TO_RESTORE = 5        // 最多恢复文件数
```

Compact 后 skill 处理流程：
1. 按最近使用时间排序
2. 每个 skill 截断到 5K tokens（保留头部，约 20KB / 500 行）
3. 总预算 25K tokens，超出则丢弃最旧的 skill
4. 截断后会追加提示：`[... skill content truncated for compaction; use Read on the skill path if you need the full text]`

**当前 SKILL.md 183 行，远在 5K token 安全线内，不会被截断。** 因此 SKILL.md 前 10 行放恢复检查指令是双重保险，而非唯一依赖。

## 附录 B：完整恢复流程时序图

```
用户输入 "/devin 做 xxx"
  │
  ├─ CLAUDE.md 全局规则触发 ──→ 识别项目路径
  │                              │
  │                              ├─ .devin-state.json 不存在
  │                              │   └─→ 正常进入 Phase 1
  │                              │
  │                              ├─ .devin-state.json 存在, phase="done"
  │                              │   ├─→ 输出 "上次任务已完成 (PR: url)"
  │                              │   ├─→ 删除状态文件
  │                              │   └─→ 正常进入 Phase 1
  │                              │
  │                              └─ .devin-state.json 存在, phase!="done"
  │                                  │
  │                                  ├─ branch 与当前任务相同?
  │                                  │   ├─ 是 → 恢复流程
  │                                  │   └─ 否 → 提示用户选择
  │                                  │
  │                                  └─ 恢复流程:
  │                                      ├─ git checkout {branch}
  │                                      ├─ git diff --stat 验证
  │                                      ├─ 对比 plan vs 实际 diff
  │                                      └─ 跳转到对应 phase 继续
  │
  └─ SKILL.md 恢复检查（compact 后的备份触发点）
      └─ 同上逻辑
```
