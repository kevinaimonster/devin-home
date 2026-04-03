# SPEC-05 v2: 智能重试策略

**优先级**: P1  
**来源**: Claude Code denial tracking — 连续失败自动回退到人工，防止死循环  
**影响范围**: SKILL.md Phase 3.3 验证节，替换现有"最多 3 轮"规则  
**版本**: v2 — 基于第一轮审查反馈的全面修订

---

## 与 v1 的关键差异

| 项目 | v1 | v2 |
|------|----|----|
| 错误识别方式 | 结构化签名提取（TS2345:oauth.ts） | 保留原始输出最后 100 行，由 Claude 直接判断"是否本质相同" |
| 进步定义 | 未定义 | 错误总数减少 OR 至少一个旧错误消失 |
| build/test 关系 | 混在一起 | 分离：build 先行，各自独立计数 |
| flaky test | 未覆盖 | 无代码修改时 re-run 一次，仍失败标记为 flaky 跳过 |
| 安全阀 | 仅轮次上限 | 轮次 + 单轮文件修改数 + 总成本 |
| 中间反馈 | 无 | 每轮输出一行进度摘要 |
| 运行时错误 | 未覆盖 | OOM/segfault/timeout 直接停止并报告 |

---

## 设计原理：为什么放弃结构化签名提取

v1 试图让 Claude 从 build 输出中提取结构化的错误签名（`错误类型 + 文件名`）。这是过度设计：

1. **Claude 不是 parser** — 不同语言、不同工具链的错误格式差异极大（TypeScript vs Rust vs Python vs Go vs Java），维护提取规则的成本远超收益
2. **签名粒度难以拿捏** — 太粗（只看错误类型）会误判不同错误为相同；太细（含行号）会因修复引起的行号漂移而误判相同错误为不同
3. **Claude 擅长的是语义理解** — 直接让 Claude 比较两段错误输出文本，判断"是否在同一个问题上打转"，比任何结构化规则都更准确

**借鉴 Claude Code denial tracking 的核心思想**：Claude Code 的 `denialTracking.ts` 不尝试分析"被拒绝的是什么操作"，只追踪连续失败次数。成功一次就重置连续计数。我们采用类似的简洁模型——不分析错误内容的结构，只关心"是否在进步"。

---

## 问题陈述

当前 devin-dispatcher 的 Phase 3.3 使用固定的"最多 3 轮"重试规则：

```
如果验证失败 → 读错误信息 → 修复 → 重新验证（最多 3 轮）
```

存在的问题：

1. **不区分进步 vs 原地打转** — 每次都是不同错误（持续进步）时 3 轮可能不够；3 次同一错误（根本不会修）时白白浪费
2. **没有智能退出** — 不管情况都消耗到上限才停
3. **build 和 test 混为一谈** — build 错误是确定性的（同样的代码必然同样的错误），test 错误可能有 flaky 因素
4. **多错误并存时无法衡量进步** — 一次 build 报 5 个错误，修一个引入两个，算进步还是退步？
5. **缺少运行时异常处理** — OOM、segfault、timeout 不是"可以修一下再试"的错误
6. **缺少成本控制** — 修复范围失控时没有刹车机制

---

## 需求描述

### 核心概念

#### 错误快照

每轮 build/test 执行后，保留输出的**最后 100 行**作为"错误快照"（error snapshot）。不做任何结构化提取。

```
error_snapshot = build/test 输出的最后 100 行原始文本
```

#### 进步判定

每轮执行后，将本轮错误快照与上轮错误快照一起交给 Claude，问一个简单的问题：

```
请比较这两轮的错误输出，回答以下问题：
1. 本轮的错误是否与上轮本质相同（同一个问题未被解决）？回答 SAME 或 DIFFERENT
2. 如果 DIFFERENT：错误总数是增加了、减少了、还是持平？回答 MORE / FEWER / EQUAL
3. 一句话总结本轮的变化
```

**进步的定义**（满足任一即为进步）：
- 判定结果为 DIFFERENT 且错误数 FEWER
- 判定结果为 DIFFERENT 且错误数 EQUAL（旧错误消失，但出现了同数量的新错误——至少不是原地打转）

**原地打转的定义**：
- 判定结果为 SAME
- 判定结果为 DIFFERENT 且错误数 MORE（越修越多）

#### 运行时异常

以下信号不视为普通错误，**直接停止并报告**，不进入重试循环：

| 信号 | 识别方式 | 处理 |
|------|----------|------|
| OOM (Out of Memory) | 输出含 `Killed`、`out of memory`、`ENOMEM`、exit code 137 | 停止，报告内存不足 |
| Segfault | 输出含 `segmentation fault`、`SIGSEGV`、exit code 139 | 停止，报告段错误 |
| Timeout | 命令执行超过 5 分钟无输出 | 停止，报告超时 |
| 磁盘空间不足 | 输出含 `No space left on device`、`ENOSPC` | 停止，报告磁盘满 |

---

### Phase 3.3 验证（智能重试策略）

替换现有"最多 3 轮"规则。Build 和 Test 分离处理，各自独立计数。

#### 3.3.1 Build 阶段

```
状态:
  build_round = 0
  build_max_rounds = 5
  prev_build_snapshot = null
  stagnation_count = 0        # 连续未进步轮数

流程:
1. 运行 build 命令
2. 如果 build 成功（exit code 0）:
   → 进入 3.3.2 Test 阶段
3. 如果 build 失败:
   a. 检查运行时异常（OOM/segfault/timeout）→ 如匹配则直接停止并报告
   b. build_round += 1
   c. 保存本轮错误快照（最后 100 行）
   d. 如果 prev_build_snapshot 存在:
      - 调用进步判定
      - 如果判定为 SAME → 停止重试（同一问题连续出现 2 次）
      - 如果判定为 DIFFERENT + MORE → stagnation_count += 1
      - 如果判定为进步 → stagnation_count = 0
   e. 如果 build_round >= build_max_rounds → 停止重试
   f. 如果 stagnation_count >= 2 → 停止重试（越修越多，连续 2 轮退步）
   g. 检查安全阀（见下文）
   h. 输出中间进度
   i. 读取错误 → 修复代码
   j. prev_build_snapshot = 本轮快照
   k. 回到步骤 1
```

#### 3.3.2 Test 阶段

仅在 build 通过后进入。独立计数。

```
状态:
  test_round = 0
  test_max_rounds = 5
  prev_test_snapshot = null
  stagnation_count = 0

流程:
1. 运行 test 命令
2. 如果 test 全部通过:
   → 进入 3.4 验证 Agent（或 3.5 提交）
3. 如果 test 失败:
   a. 检查运行时异常 → 如匹配则直接停止并报告
   b. test_round += 1
   c. 保存本轮错误快照
   d. 如果 prev_test_snapshot 存在:
      - 检查 flaky test 情况（见 3.3.3）
      - 调用进步判定
      - 如果判定为 SAME → 停止重试
      - 如果判定为 DIFFERENT + MORE → stagnation_count += 1
      - 如果判定为进步 → stagnation_count = 0
   e. 如果 test_round >= test_max_rounds → 停止重试
   f. 如果 stagnation_count >= 2 → 停止重试
   g. 检查安全阀
   h. 输出中间进度
   i. 读取错误 → 修复代码
   j. 修复后**先重跑 build**，确认 build 仍然通过
      - 如果 build 失败 → 回到 3.3.1（build 计数继续，不重置）
   k. prev_test_snapshot = 本轮快照
   l. 回到步骤 1
```

#### 3.3.3 Flaky Test 处理

当 test 失败时，在尝试修复前先判断是否为 flaky test：

```
判断条件（同时满足）:
  1. 本轮 test 失败的 case 与上轮完全相同
  2. 两轮之间没有代码修改（即上次修复后没有改任何文件）

如果疑似 flaky:
  1. 不修改代码，直接 re-run test 一次
  2. 如果 re-run 通过 → 标记为 flaky，继续后续流程
  3. 如果 re-run 仍失败 → 标记为 flaky 并跳过这些 test case
     - 在最终汇报中列出被跳过的 flaky test 及其输出
     - 如果去掉 flaky test 后剩余 test 全部通过 → 视为通过（带 warning）
```

**注意**：flaky test re-run 不计入 test_round。

#### 3.3.4 Warning 处理

```
0 error + 有 warning:
  → 视为通过，不阻塞后续步骤
  → 在最终汇报中列出所有 warnings
  → 如果 warning 包含以下关键词，显式高亮提醒用户:
    - deprecated（废弃 API）
    - unsafe / security（潜在安全问题）
    - memory leak（内存泄漏风险）
```

---

### 安全阀

除轮次上限外，增加以下安全控制：

#### 单轮文件修改数上限

```
每轮修复后，检查本轮修改的文件数（git diff --name-only | wc -l）:
  - 如果 > 10 个文件 → 立即停止
  - 向用户报告："本轮修复涉及 N 个文件，改动范围可能失控，建议人工审查"
  - 附上修改文件列表
```

#### 总修改文件数上限

```
所有轮次累计修改的不同文件数:
  - 如果 > 20 个文件 → 停止并报告
  - 说明改动范围远超预期
```

---

### 中间进度反馈

每轮重试完成后，输出一行进度摘要：

```
格式:
  [Build 第 N/5 轮] 修复了 X 个错误，还剩 Y 个错误
  [Test 第 N/5 轮] 修复了 X 个失败用例，还剩 Y 个失败
  [Build 第 N/5 轮] 与上轮相同的错误，停止重试
  [Test 第 N/5 轮] 标记 X 个 flaky test，跳过后剩余 test 通过

示例:
  [Build 第 1/5 轮] 3 个编译错误，开始修复...
  [Build 第 2/5 轮] 修复了 2 个错误，还剩 1 个新错误
  [Build 第 3/5 轮] 0 error，build 通过。进入 test 阶段
  [Test 第 1/5 轮] 2 个 test 失败，开始修复...
  [Test 第 2/5 轮] 修复了 1 个失败，还剩 1 个失败
  [Test 第 2/5 轮] 疑似 flaky test，无代码修改，re-run 确认中...
  [Test 第 2/5 轮] 标记 1 个 flaky test，跳过后全部通过
```

---

### 重试报告格式

最终汇报中包含完整的重试记录：

```markdown
### Build/Test 重试记录

**Build 阶段**: 3 轮，最终通过
**Test 阶段**: 2 轮 + 1 个 flaky test，最终通过（带 warning）

| 阶段 | 轮次 | 错误概述 | 修复操作 | 进步判定 | 修改文件数 |
|------|------|----------|----------|----------|------------|
| Build | 1 | 3 个类型错误 | 修正类型声明 | — | 2 |
| Build | 2 | 1 个类型错误（新） | 添加类型注解 | DIFFERENT/FEWER | 1 |
| Build | 3 | 0 error | — | 通过 | 0 |
| Test | 1 | 2 个用例失败 | 更新 mock 数据 | — | 1 |
| Test | 2 | 1 个用例失败（flaky） | 跳过 | SAME→flaky | 0 |

**Warnings**: 
- `oauth.ts:15` — `deprecation: Buffer() is deprecated`

**Flaky Tests**:
- `auth.test.ts > should handle timeout` — 无代码修改下时过时不过，已跳过

**累计修改文件**: 4 个
```

---

### 完整决策流程图

```
build 命令
  │
  ├── 运行时异常? ──→ 停止，报告异常类型
  │
  ├── 成功? ──→ test 命令
  │              │
  │              ├── 运行时异常? ──→ 停止，报告
  │              │
  │              ├── 成功? ──→ 3.4 验证 Agent
  │              │
  │              ├── 0 error + warning? ──→ 通过（汇报 warnings）
  │              │
  │              └── 失败:
  │                   ├── 疑似 flaky? ──→ re-run ──→ 通过? → 标记并继续
  │                   │                            └── 仍失败? → 标记跳过
  │                   ├── 与上轮 SAME? ──→ 停止
  │                   ├── DIFFERENT + MORE 连续 2 轮? ──→ 停止
  │                   ├── 修改文件 > 10? ──→ 停止
  │                   ├── 累计文件 > 20? ──→ 停止
  │                   ├── test_round >= 5? ──→ 停止
  │                   └── 修复 → 确认 build 仍通过 → 重跑 test
  │
  ├── 0 error + warning? ──→ 进入 test 阶段（汇报 warnings）
  │
  └── 失败:
       ├── 与上轮 SAME? ──→ 停止
       ├── DIFFERENT + MORE 连续 2 轮? ──→ 停止
       ├── 修改文件 > 10? ──→ 停止
       ├── 累计文件 > 20? ──→ 停止
       ├── build_round >= 5? ──→ 停止
       └── 修复 → 重跑 build
```

---

### 与其他 SPEC 的协同

| SPEC | 关系 |
|------|------|
| SPEC-01 验证 Agent | 本 SPEC 处理 build/test 的编译和测试错误。SPEC-01 的验证 Agent 在 build/test **全部通过后**才介入，检查逻辑正确性。两者独立运作，不共享计数 |
| SPEC-03 进度追踪 | 每轮重试的中间进度摘要应同步写入进度追踪系统 |
| SPEC-04 状态持久化 | 错误快照和重试状态需要持久化，以便断点恢复后能继续重试流程而非从头开始 |

---

## 对 SKILL.md 的具体修改

1. 替换 Phase 3.3 中的"最多 3 轮"段落为本 SPEC 的完整重试逻辑
2. 增加 build/test 分离执行的描述
3. 增加中间进度输出格式
4. 增加重试报告格式模板
5. 增加安全阀规则
6. 增加 flaky test 处理规则

---

## 边界条件与风险

| 风险 | 应对 |
|------|------|
| Claude 错误判定"SAME vs DIFFERENT" | 保守策略：如果无法确定，默认判定为 SAME（宁可早停也不浪费轮次）。同时保留两轮完整快照供用户复查 |
| build 输出超过 100 行的有效信息 | 100 行是默认值。如果前 100 行都是重复的 warning，向上扫描到第一个 error 行，确保快照包含至少一个 error |
| test 命令无法单独跑指定 case（无法跳过 flaky） | 在报告中标注"无法跳过 flaky test，需要人工处理"，不强求跳过 |
| 修复 test 导致 build 再次失败 | 3.3.2 步骤 j 已覆盖：修复 test 后先重跑 build，build 失败则回到 3.3.1 |
| 5 轮重试仍有新错误（连锁问题） | 已通过 stagnation_count 和文件修改数双重检测。连续退步 2 轮或单轮修改 > 10 文件都会提前停止 |
| 某些项目没有 test 命令 | 如果 DEVIN.md / projects.json 中没有 test 命令，跳过 3.3.2，build 通过后直接进入 3.4 |
| 项目 build 本身很慢（> 5 分钟） | timeout 检测针对"无输出"的情况。build 持续有输出时不触发 timeout。对于已知慢 build 的项目，可在 DEVIN.md 中配置 `build_timeout` 覆盖默认值 |

---

## 验收标准

1. **同一错误检测**：build/test 在本质相同的错误上连续失败 2 次时，自动停止并向用户报告
2. **持续进步**：每轮都有不同错误时，能重试到第 5 轮
3. **退步检测**：错误越修越多，连续 2 轮退步时提前停止
4. **build/test 分离**：build 失败时不跑 test；test 修复后重新验证 build
5. **flaky test**：无代码修改时检测到 flaky test，re-run 一次确认后标记跳过
6. **安全阀**：单轮修改 > 10 个文件时停止；累计修改 > 20 个文件时停止
7. **中间进度**：每轮重试后输出一行进度摘要
8. **运行时异常**：OOM/segfault/timeout 直接停止，不进入重试循环
9. **warning 处理**：0 error + warning 视为通过，但在汇报中列出
10. **最终报告**：汇报中包含完整的重试记录表格、flaky test 列表、warning 列表
