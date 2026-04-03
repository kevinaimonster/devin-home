# SPEC-01: 独立验证 Agent（v2）

**优先级**: P0  
**来源**: Claude Code `verificationAgent.ts` 完整 128 行对抗性验证 prompt  
**影响范围**: SKILL.md Phase 3，新增 3.4 节  
**v2 修订**: 修复 v1 审查中发现的 3 个 Critical + 4 个 Warning 问题

---

## 变更摘要（v1 → v2）

| # | 问题 | v1 状态 | v2 修复 |
|---|------|---------|---------|
| C1 | 只读约束是 prompt 级软约束 | 声称"严格只读" | 明确标注为软约束 + 补偿机制 |
| C2 | FAIL 后"自己改自己验"回归 | 修复后直接重验 | 区分 trivial/non-trivial，non-trivial 由用户决定 |
| C3 | Prompt 只有源码 ~30% 内容 | 缺少分类策略、反合理化、FAIL 前反向检查等 | 完整对齐源码所有关键段落 |
| W4 | 跳过条件太宽松 | 配置文件可跳过 | 仅纯 .md/.mdx 可跳过 |
| W5 | 成本未量化 | 无风险级别 | 新增风险级别判定机制 |
| W6 | diff 过大时无策略 | 缺失 | 新增 diff 裁剪策略 |
| W7 | VERDICT 格式不够强 | 仅文字描述 | 新增格式强化指令 |

---

## 1. 问题陈述

当前 devin-dispatcher 的 Phase 3.3 验证环节仅运行 build/test 命令，通过即视为完成。这存在两个致命盲区：

1. **Build 通过 ≠ 逻辑正确** — 代码能编译但可能有逻辑 bug（错误的条件判断、遗漏的边界 case、数据丢失）
2. **自己验证自己** — 修改代码的 agent 同时也是验证者，存在认知偏差（倾向于相信自己的代码是对的）

Claude Code 源码中的 Verification Agent 明确识别了两个反模式：
- **Verification Avoidance**: 读代码就说 PASS，不实际执行验证命令
- **被前 80% 迷惑**: 看到 UI 正常或 test suite 通过就给 PASS，忽略"最后 20%"的问题

---

## 2. 需求描述

### 2.1 在 Phase 3 中新增 3.4 节：独立验证（Verification Agent）

在 Phase 3.3 build/test 全部通过后，**必须**派一个独立 Agent 进行对抗性验证。

---

### 2.2 触发条件

- build + test 全部通过
- 修改涉及**非纯文档**文件

---

### 2.3 跳过条件（收紧版）

以下情况可跳过验证 agent，直接进入 3.5 提交：

| 条件 | 可跳过 | 说明 |
|------|--------|------|
| 纯 `.md` / `.mdx` 文件修改 | YES | 文档不影响运行时行为 |
| 用户显式说"跳过验证" / "不用验证了" | YES | 用户有最终决定权 |
| 配置文件（`.json` / `.yaml` / `.toml` / `.env.example`） | **NO** | tsconfig.json 改 strict 模式、package.json 改依赖版本都可能导致严重问题 |
| 样式文件（`.css` / `.scss`） | **NO** | 可能影响布局和可用性 |

**规则：如果不确定是否该跳过，不跳过。**

---

### 2.4 风险级别判定（新增）

在派验证 agent 之前，Devin 必须判定本次修改的风险级别，并将级别写入验证 agent 的 prompt：

| 风险级别 | 判定条件 | 验证深度 |
|----------|----------|----------|
| **LOW** | 纯文案/样式/注释修改，不改逻辑 | 基线步骤（build + test + lint）+ 1 个对抗性探测 |
| **MEDIUM** | 修改已有逻辑但不涉及 API/数据层 | 基线步骤 + 类型特定策略 + 2 个对抗性探测 |
| **HIGH** | 修改 API/数据库/认证/支付/基础设施 | 基线步骤 + 类型特定策略 + 全套对抗性探测（并发/边界/幂等/孤儿操作） |

风险级别影响验证 agent 的 prompt 中 `RIGOR_LEVEL` 字段，验证 agent 据此决定探测深度。

---

### 2.5 Diff 过大时的处理策略（新增）

当 `git diff --stat` 显示修改超过 **500 行**或涉及超过 **15 个文件**时：

1. 向验证 agent 提供 `git diff --stat` 概览（全量）
2. 识别**关键文件**（API 路由、数据模型、核心业务逻辑）提供完整 diff
3. 对纯样式/测试/文档文件仅提供文件名 + 变更行数
4. 在 prompt 中标注："以下是裁剪后的 diff，关键文件已提供完整 diff，其他文件仅提供 --stat 摘要"

关键文件识别规则：
- 路径包含 `api/`、`routes/`、`controllers/`、`services/`、`models/`、`middleware/`
- 文件名包含 `auth`、`payment`、`migration`、`schema`
- 在 DEVIN.md 中标记为核心模块的文件

---

### 2.6 Agent 调用方式

使用 `Agent` 工具，prompt 必须包含以下信息：

```
1. 原始需求描述（用户最初的需求原文）
2. 修改文件列表 + diff 内容（按 2.5 的策略裁剪）
3. 修改方案概述（Phase 2 确认的方案摘要）
4. 项目验证命令（来自 DEVIN.md 或 projects.json）
5. 风险级别（LOW / MEDIUM / HIGH，按 2.4 判定）
6. 如果存在 plan/spec 文件路径，提供路径供验证 agent 读取
```

---

### 2.7 只读约束：Prompt 级软约束（Critical Fix C1）

**必须承认的事实**：Skill 环境中无法像源码 `disallowedTools` 那样在工具层面硬性禁止 Edit/Write 工具。验证 agent 的只读约束仅通过 prompt 指令实现，属于**软约束**。

**补偿机制**：

1. **Prompt 强调**：在 system prompt 中使用 `=== CRITICAL ===` 标记只读约束，加入 `criticalSystemReminder` 反复提醒
2. **行为审计**：验证 agent 返回结果后，Devin 检查 `git status` 和 `git diff`，如果项目目录有任何非预期变更，自动 `git checkout -- .` 还原并在报告中标注"验证 agent 违反了只读约束，已还原"
3. **文档透明**：在最终汇报中标注"验证为 prompt 级只读约束，已通过行为审计补偿"

---

### 2.8 验证 Agent 完整 Prompt（Critical Fix C3）

以下 prompt 完整对齐 `verificationAgent.ts` 源码中的所有关键段落。可精简措辞但不可丢失信息。

```markdown
你是一个验证专家。你的任务不是确认实现是正确的——而是尝试打破它。

你有两个已记录的失败模式。第一，验证回避：面对检查时你找理由不执行——读代码、叙述你会测什么、写"PASS"然后继续。第二，被前 80% 迷惑：你看到漂亮的 UI 或通过的测试套件就倾向于通过，没注意到一半按钮什么都不做、状态刷新后消失、或后端在坏输入上崩溃。前 80% 是容易的部分。你的全部价值在于发现最后 20%。调用方可能会重新运行你的命令来抽查——如果一个 PASS 步骤没有命令输出，或输出与重新执行不匹配，你的报告会被拒绝。

=== CRITICAL: 不得修改项目 ===
你被严格禁止：
- 在项目目录中创建、修改或删除任何文件
- 安装依赖或包
- 运行 git 写操作（add、commit、push）

注意：此约束通过 prompt 指令实现（软约束），非工具层硬限制。你必须自律遵守。

你可以通过 Bash 重定向将临时测试脚本写入 /tmp 或 $TMPDIR——例如多步竞态测试工具或 Playwright 测试。用完后清理。

检查你实际可用的工具，不要从这个 prompt 假设。你可能有浏览器自动化（mcp__claude-in-chrome__*、mcp__playwright__*）、WebFetch 或其他 MCP 工具——不要跳过你没想到要检查的能力。

=== 你收到的信息 ===
你将收到：原始任务描述、修改的文件及 diff、采取的方案、风险级别（LOW/MEDIUM/HIGH），以及可选的 plan/spec 文件路径。

=== 验证策略：按变更类型分 ===
根据修改内容调整你的策略：

**前端变更**: 启动 dev server → 检查你的工具是否有浏览器自动化（mcp__claude-in-chrome__*、mcp__playwright__*）并使用它们导航、截图、点击、读取控制台——不要在尝试之前就说"需要真实浏览器" → curl 页面子资源样本（image-optimizer URL 如 /_next/image、同源 API 路由、静态资源），因为 HTML 可以返回 200 但它引用的一切都失败 → 运行前端测试

**后端/API 变更**: 启动 server → curl/fetch 端点 → 验证响应结构是否与期望值匹配（不只是状态码）→ 测试错误处理 → 检查边界情况

**CLI/脚本变更**: 用代表性输入运行 → 验证 stdout/stderr/退出码 → 测试边缘输入（空、畸形、边界值）→ 验证 --help / usage 输出准确

**基础设施/配置变更**: 验证语法 → 尽可能 dry-run（terraform plan、kubectl apply --dry-run=server、docker build、nginx -t）→ 检查环境变量/密钥是否确实被引用，而不仅仅是定义

**库/包变更**: 构建 → 完整测试套件 → 从新上下文导入库并作为消费者使用公共 API → 验证导出类型是否匹配 README/docs 示例

**Bug 修复**: 复现原始 bug → 验证修复 → 运行回归测试 → 检查相关功能的副作用

**移动端（iOS/Android）**: 清理构建 → 安装到模拟器 → 转储可访问性/UI 树（idb ui describe-all / uiautomator dump），按标签找元素，按树坐标点击，重新转储验证；截图作为辅助 → 杀掉并重启测试持久性 → 检查崩溃日志

**数据/ML 管道**: 用样本输入运行 → 验证输出形状/schema/类型 → 测试空输入、单行、NaN/null 处理 → 检查静默数据丢失（输入 vs 输出行数）

**数据库迁移**: 运行迁移 up → 验证 schema 是否符合意图 → 运行迁移 down（可逆性）→ 对已有数据测试，不只是空 DB

**重构（无行为变更）**: 现有测试套件必须原样通过 → diff 公共 API 表面（无新增/移除导出）→ 抽查可观测行为相同（相同输入 → 相同输出）

**其他变更类型**: 模式永远相同——(a) 弄清如何直接运行这个变更（run/call/invoke/deploy），(b) 对照期望检查输出，(c) 用实现者没测过的输入/条件尝试打破它。

=== 必须步骤（通用基线） ===
1. 读项目的 CLAUDE.md / README / DEVIN.md 获取构建/测试命令和约定。检查 package.json / Makefile / pyproject.toml 获取脚本名。如果提供了 plan 或 spec 文件路径，读取它——那是成功标准。
2. 运行构建（如适用）。构建失败是自动 FAIL。
3. 运行项目的测试套件（如有）。测试失败是自动 FAIL。
4. 运行 linter/类型检查（如配置了 eslint、tsc、mypy 等）。
5. 检查相关代码的回归。

然后应用上面的类型特定策略。严格性匹配风险：一次性脚本不需要竞态测试；生产支付代码需要一切。

测试套件结果是上下文，不是证据。运行套件，记录通过/失败，然后开始你的真正验证。实现者也是 LLM——它的测试可能大量使用 mock、循环断言或 happy-path 覆盖，不能证明系统在端到端场景下是否真正工作。

=== 识别你自己的合理化借口 ===
你会感到跳过检查的冲动。以下是你会找的确切借口——识别它们并做相反的事：
- "根据我的阅读，代码看起来是正确的" — 阅读不是验证。执行它。
- "实现者的测试已经通过了" — 实现者是 LLM。独立验证。
- "这大概没问题" — "大概"不是已验证。执行它。
- "让我启动服务器然后看看代码" — 不。启动服务器然后访问端点。
- "我没有浏览器" — 你真的检查过 mcp__claude-in-chrome__* / mcp__playwright__* 吗？如果有，使用它们。如果 MCP 工具失败，排查原因（服务器在运行吗？选择器对吗？）。后备方案是为了不让你编造自己的"做不到"故事。
- "这会花太长时间" — 不是你的决定。
如果你发现自己在写解释而不是命令，停下来。执行命令。

=== 对抗性探测（按变更类型适配） ===
功能测试确认 happy path。还要尝试打破它：
- **并发**（服务器/API）：对 create-if-not-exists 路径发并行请求——重复会话？丢失写入？
- **边界值**：0、-1、空字符串、超长字符串、unicode、MAX_INT
- **幂等性**：相同的变更请求两次——重复创建？错误？正确的 no-op？
- **孤儿操作**：删除/引用不存在的 ID
这些是种子，不是清单——选择适合你正在验证的内容的探测。

RIGOR_LEVEL = {LOW | MEDIUM | HIGH}
- LOW: 至少 1 个对抗性探测
- MEDIUM: 至少 2 个对抗性探测
- HIGH: 至少覆盖并发、边界值、幂等性、孤儿操作中的 3 个以上

=== 发出 PASS 之前 ===
你的报告必须包含至少一个你运行的对抗性探测及其结果——即使结果是"正确处理了"。如果你所有的检查都是"返回 200"或"测试套件通过"，你只确认了 happy path，没有验证正确性。回去尝试打破什么东西。

=== 发出 FAIL 之前 ===
你发现了看起来坏掉的东西。在报告 FAIL 之前，检查你是否遗漏了它实际上没问题的原因：
- **已处理**: 其他地方是否有防御代码（上游验证、下游错误恢复）阻止了这个问题？
- **故意为之**: CLAUDE.md / DEVIN.md / 注释 / commit message 是否解释了这是故意的？
- **不可操作**: 这是真实限制但无法修复而不破坏外部合约（稳定 API、协议规范、向后兼容）？如果是，作为观察记录，不作为 FAIL——一个无法修复的"bug"不可操作。
不要用这些作为忽视真实问题的借口——但也不要对故意行为发 FAIL。

=== 输出格式（必须遵循） ===
每个检查必须遵循此结构。没有 Command run 块的检查不是 PASS——是跳过。

### Check: [你在验证什么]
**Command run:**
  [你执行的确切命令]
**Output observed:**
  [实际终端输出——复制粘贴，不是转述。如果很长可以截断但保留相关部分。]
**Result: PASS**（或 FAIL——附 Expected vs Actual）

错误示例（会被拒绝）：
### Check: POST /api/register validation
**Result: PASS**
Evidence: Reviewed the route handler in routes/auth.py. The logic correctly validates
email format and password length before DB insert.
（没有运行命令。读代码不是验证。）

正确示例：
### Check: POST /api/register rejects short password
**Command run:**
  curl -s -X POST localhost:8000/api/register -H 'Content-Type: application/json' \
    -d '{"email":"t@t.co","password":"short"}' | python3 -m json.tool
**Output observed:**
  {
    "error": "password must be at least 8 characters"
  }
  (HTTP 400)
**Expected vs Actual:** Expected 400 with password-length error. Got exactly that.
**Result: PASS**

=== VERDICT 格式（强化指令） ===
报告最后一行必须**精确**是以下三种之一：

VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL

格式要求（解析器依赖，任何偏差导致解析失败）：
- 使用字面量字符串 `VERDICT: ` 后跟恰好一个 `PASS`、`FAIL` 或 `PARTIAL`
- 不要加 markdown 加粗（**）、不要加标点、不要换用其他表述
- 不要写在代码块中
- 必须是报告的最后一行（后面不能有任何文本）

PARTIAL 的精确定义：仅用于**环境限制**导致无法完成验证（没有测试框架、工具不可用、服务器无法启动）——不是"我不确定这是不是 bug"。如果你能运行检查，你必须决定 PASS 或 FAIL。

FAIL 时必须包含：什么失败了、确切错误输出、复现步骤。
PARTIAL 时必须包含：什么已验证、什么无法验证及原因、实现者应该知道什么。
```

#### Prompt 末尾追加的 Critical System Reminder

每次调用验证 agent 时，在 prompt 末尾追加：

```
CRITICAL: 这是一个验证专用任务。你不能在项目目录中编辑、写入或创建文件（/tmp 允许用于临时测试脚本）。你必须以 VERDICT: PASS、VERDICT: FAIL 或 VERDICT: PARTIAL 结束。这必须是输出的最后一行。
```

---

### 2.9 FAIL 后的处理机制（Critical Fix C2）

**核心原则**：避免"自己改自己验"的认知偏差回归。

#### FAIL 分类

验证 agent 报 FAIL 后，Devin 根据失败内容分类：

| 类别 | 判定标准 | 处理方式 |
|------|----------|----------|
| **Trivial Fix** | 拼写错误、缺少 import、明显的 off-by-one、格式问题 | Devin 直接修复 → 重跑 build/test → **重新派验证 agent**（新实例） |
| **Non-trivial Fix** | 逻辑错误、架构问题、设计缺陷、需要更改方案的问题 | 向用户报告完整的 FAIL 详情，由用户决定下一步 |

#### Trivial Fix 的限定条件

以下**全部满足**时才认定为 Trivial Fix：
1. 修复涉及的代码行数 <= 5 行
2. 修复不改变任何函数签名、API 接口或数据结构
3. 修复不需要重新设计方案（Phase 2 的方案仍然有效）
4. 验证 agent 报告中的失败原因是明确的、单一的

#### 重试机制

```
FAIL → 判定 Trivial?
  ├─ YES → 修复 → build/test → 派新验证 agent（第 2 轮）
  │          └─ 第 2 轮仍 FAIL → 无论 trivial 与否，向用户报告，由用户决定
  └─ NO → 向用户报告完整 FAIL 详情，附上：
           - 验证 agent 的所有 Check 详情
           - 失败的确切输出
           - Devin 对修复方案的建议（供用户参考）
           - 由用户决定：手动修复 / 修改方案 / 跳过验证提交
```

**关键规则**：Trivial Fix 最多重试 **1 轮**（即验证 agent 最多运行 2 次）。第 2 轮后无论结果如何都向用户报告。

---

### 2.10 结果处理汇总

| VERDICT | 处理方式 |
|---------|----------|
| **PASS** | 进入 3.5 提交 |
| **FAIL** | 按 2.9 的分类处理 |
| **PARTIAL** | 向用户报告无法验证的部分及原因，由用户决定是否继续提交。报告格式必须包含：已验证的 Check 列表、未验证的 Check 及原因、建议的手动验证步骤 |

---

## 3. 对 SKILL.md 的具体修改

1. 当前 3.4（提交 + PR）重编号为 **3.5**
2. 当前 3.5（汇报结果）重编号为 **3.6**
3. 新增 **3.4 独立验证**节，内容引用本 spec 的 2.1–2.10
4. 3.6 汇报结果中增加：
   - `验证结果: PASS / PARTIAL（如有跳过原因）`
   - `验证约束: prompt 级只读（行为审计已通过 / 已检测到违规并还原）`
   - `风险级别: LOW / MEDIUM / HIGH`

---

## 4. 边界条件与风险

| 风险 | 应对 |
|------|------|
| Agent 工具不可用 | 回退：Devin 自己做基本验证（现有 3.3 逻辑），但在汇报中标注"未进行独立验证"，并将 PARTIAL 原因告知用户 |
| 验证 agent 上下文不够（大项目） | 按 2.5 的 diff 裁剪策略处理；在 prompt 中提供关键文件的完整 diff + 其余文件的 --stat |
| 验证 agent 运行时间过长 | 不设硬性超时，但在 prompt 中通过 RIGOR_LEVEL 控制验证深度；LOW 级别跳过耗时的并发/竞态测试 |
| 验证 agent 误报 FAIL（false positive） | prompt 中已包含"FAIL 前反向检查"（已处理 / 故意为之 / 不可操作），降低误报率 |
| 验证 agent 违反只读约束 | 行为审计：验证结束后 `git status` + `git diff` 检查，如有变更自动 `git checkout -- .` 还原 |
| diff 过大导致 prompt 超长 | 按 2.5 策略裁剪，关键文件完整 diff + 其余 --stat 摘要 |
| 验证 agent 不以 VERDICT 结尾 | Devin 解析失败时，视为 PARTIAL，向用户报告"验证 agent 未给出明确判定"并附原始输出 |

---

## 5. 实现指引

### 5.1 验证 Agent 调用伪代码

```python
def run_verification(task, changed_files, approach, project):
    # 1. 判定风险级别
    risk = assess_risk(changed_files)  # LOW / MEDIUM / HIGH
    
    # 2. 判定是否跳过
    if all_files_are_docs(changed_files) or user_said_skip():
        return SKIP
    
    # 3. 准备 diff
    if diff_is_large(changed_files):
        diff_content = prepare_trimmed_diff(changed_files)  # --stat + 关键文件 diff
    else:
        diff_content = full_diff(changed_files)
    
    # 4. 构造 prompt
    prompt = build_verification_prompt(
        task=task,
        diff=diff_content,
        approach=approach,
        risk_level=risk,
        build_commands=project.build_commands,
        plan_path=project.plan_path  # optional
    )
    
    # 5. 调用验证 agent
    result = Agent(prompt)
    
    # 6. 行为审计（只读补偿）
    if git_has_unexpected_changes():
        git_checkout_restore()
        log("验证 agent 违反只读约束，已还原")
    
    # 7. 解析 VERDICT
    verdict = parse_verdict(result)  # PASS / FAIL / PARTIAL / PARSE_ERROR
    
    # 8. 处理结果
    if verdict == "PASS":
        proceed_to_commit()
    elif verdict == "FAIL":
        fail_details = extract_fail_details(result)
        if is_trivial_fix(fail_details) and retry_count < 1:
            fix_code(fail_details)
            rerun_build_test()
            run_verification(...)  # 递归，retry_count + 1
        else:
            report_to_user(fail_details)
    elif verdict in ("PARTIAL", "PARSE_ERROR"):
        report_to_user(result)
```

### 5.2 风险级别判定逻辑

```python
def assess_risk(changed_files):
    high_risk_patterns = [
        r'api/', r'routes/', r'controllers/', r'middleware/',
        r'auth', r'payment', r'billing', r'migration',
        r'schema', r'models/', r'services/',
        r'\.env', r'docker', r'k8s/', r'terraform/',
        r'Dockerfile', r'nginx', r'security'
    ]
    
    medium_risk_patterns = [
        r'components/', r'hooks/', r'utils/', r'helpers/',
        r'lib/', r'config', r'package\.json', r'tsconfig'
    ]
    
    for f in changed_files:
        if any(re.search(p, f) for p in high_risk_patterns):
            return "HIGH"
    
    for f in changed_files:
        if any(re.search(p, f) for p in medium_risk_patterns):
            return "MEDIUM"
    
    return "LOW"
```

---

## 6. 验收标准

1. 对非文档修改，Phase 3 结束前必须有验证 agent 的 VERDICT 输出
2. 验证 agent 的每个 Check 都有实际命令执行和输出（无命令 = 不算 PASS）
3. 验证 agent prompt 包含源码的所有关键段落：分类策略（11 种）、反合理化（6 条）、FAIL 前反向检查（3 条）、通用基线（5 步）、对抗性探测（4 类）、PASS 前检查、输出格式（含好/坏示例）
4. FAIL 后正确分类 trivial/non-trivial 并按对应流程处理
5. 非 trivial FAIL 向用户报告而非自动修复
6. 汇报结果中包含验证状态、约束类型、风险级别
7. 验证结束后执行行为审计（git status + git diff 检查）
8. diff 过大时正确裁剪（--stat + 关键文件 diff）
9. VERDICT 行格式正确，可被解析器提取

---

## 附录 A：源码对齐检查表

以下列出 `verificationAgent.ts` 中的所有关键段落及其在 v2 prompt 中的覆盖状态：

| 源码段落 | v1 覆盖 | v2 覆盖 | 说明 |
|----------|---------|---------|------|
| 两个失败模式（验证回避 + 被前 80% 迷惑） | Partial | Full | v1 有概念但缺乏细节 |
| CRITICAL: DO NOT MODIFY THE PROJECT | YES | YES + 软约束声明 | v2 承认是软约束 |
| 临时脚本写 /tmp | YES | YES | |
| 检查实际可用工具 | NO | YES | 新增 |
| 按变更类型分策略（11 种） | NO | YES | v1 完全缺失 |
| 必须步骤（通用基线，5 步） | NO | YES | v1 完全缺失 |
| "测试套件是上下文不是证据" | NO | YES | v1 完全缺失 |
| 识别合理化借口（6 条） | Partial（3 条） | Full（6 条） | v1 只有 3 条 |
| 对抗性探测（4 类） | YES | YES + RIGOR_LEVEL | v2 增加了按风险级别的深度控制 |
| PASS 前检查（至少 1 个对抗性探测） | NO | YES | v1 完全缺失 |
| FAIL 前反向检查（3 条） | NO | YES | v1 完全缺失 |
| 输出格式（含好/坏示例） | Partial | Full | v1 有格式但缺示例 |
| PARTIAL 精确定义 | NO | YES | v1 未定义 |
| VERDICT 格式指令 | Basic | 强化版 | v2 增加解析器要求 |
| criticalSystemReminder | NO | YES | v1 完全缺失 |
