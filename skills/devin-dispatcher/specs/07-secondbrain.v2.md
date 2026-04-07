# SPEC-07: SecondBrain 三层记忆体系

**优先级**: P1  
**来源**: Claude Code `SessionMemory/sessionMemory.ts` + `extractMemories/extractMemories.ts` + `autoDream/autoDream.ts`  
**影响范围**: SKILL.md Phase 3 全流程 + DEVIN.md 维护机制增强  
**版本**: v2（直接基于前 6 个 SPEC 的审查经验编写）

---

## 问题陈述

当前 devin-dispatcher 的知识积累是**被动的、单层的**：

1. **只在任务结束后更新 DEVIN.md** — 任务过程中学到的东西（踩了什么坑、发现了什么规律）如果任务中断（session 断开、compact），这些知识就丢了
2. **没有任务内学习笔记** — SPEC-04 的 `.devin-state.json` 只记录 phase/branch/plan，不记录"过程中发现了什么"
3. **没有跨任务知识整合** — 执行 10 次任务后，DEVIN.md 可能有重复条目、过时信息、碎片化的踩坑记录，没有自动整合机制

Claude Code 的 SecondBrain 用三层级联解决了这个问题：

| 层 | 触发时机 | 做什么 | 对应源码 |
|---|---------|--------|---------|
| Session Memory | 每 10K tokens + 3 次工具调用 | 维护结构化会话笔记 | `sessionMemory.ts` |
| Extract Memories | 每轮对话结束后 | 自动提取持久知识 | `extractMemories.ts` |
| Auto Dream | 24h + 5 sessions 后 | 跨 session 整合修剪 | `autoDream.ts` |

---

## 需求描述

将 SecondBrain 的三层模型适配为 devin-dispatcher 的 Skill 级指令。由于 Skill 无法注册 hooks（那是代码层的能力），我们用**显式检查点**替代自动触发。

### Tier 1: 任务内学习笔记

**做什么**：在 `.devin-state.json` 中增加 `learnings` 字段，记录任务执行过程中的发现。

**Schema 扩展**：

```json
{
  "version": 2,
  "learnings": [
    {
      "phase": "3.2",
      "type": "discovery",
      "content": "OAuthDialog 组件使用了 useContext(AuthContext)，修改 OAuth 逻辑必须同时更新 AuthContext 的 Provider"
    },
    {
      "phase": "3.3",
      "type": "gotcha",
      "content": "yarn test 需要先启动 redis：docker compose up redis -d"
    }
  ],
  ...existing fields...
}
```

**记录时机**（3 个显式检查点）：

| 检查点 | 时机 | 记录什么 |
|--------|------|----------|
| **修改后** | Phase 3.2 每个文件/模块修改完成后 | 发现的架构关系、意外的依赖、需要注意的接口约束 |
| **重试后** | Phase 3.3 每次 build/test 失败并修复后 | 失败原因、修复方法、踩坑经验 |
| **验证后** | Phase 3.4 验证 Agent 返回 FAIL 并修复后 | 验证发现的问题、修复方式 |

**Learning 类型**：

| type | 含义 | 示例 |
|------|------|------|
| `discovery` | 新发现的架构/依赖关系 | "UserService 依赖 Redis 缓存层" |
| `gotcha` | 踩坑经验 | "test 需要先 docker compose up" |
| `pattern` | 代码模式/规范 | "该项目所有 API 路由都在 routes/ 下且必须有 schema 验证" |
| `decision` | 做出的设计决策及原因 | "选择在 middleware 层处理鉴权而非 controller 层" |

**不记录什么**（借鉴源码 `WHAT_NOT_TO_SAVE_SECTION`）：
- 可从代码直接读到的信息
- 具体的代码修改内容（git diff 是权威来源）
- 临时性调试步骤

---

### Tier 2: 任务后自动提取

**做什么**：Phase 3.6 汇报结果之后，自动将 `learnings` 中有持久价值的条目提取到 DEVIN.md。

**提取流程**：

```
Phase 3.6 汇报完成
    ↓
读取 .devin-state.json 中的 learnings
    ↓
逐条评估：这个 learning 是否有跨任务价值？
    ├─ 仅对当前任务有用（如"这个 bug 的具体修复方式"）→ 不提取
    └─ 对未来任务也有用（如"test 需要先启动 redis"）→ 提取到 DEVIN.md
    ↓
按 SPEC-06 的规则写入 DEVIN.md（主键去重、分区归类）：
  - discovery → "模块地图"或"领域映射"
  - gotcha → "踩坑记录"
  - pattern → "踩坑记录"（带规范说明）
  - decision → 不写入 DEVIN.md（决策是任务特定的，除非是架构级决策）
    ↓
清除 .devin-state.json 中已提取的 learnings（或随 phase: "done" 一起清理）
```

**评估标准**（"有跨任务价值"的判断）：

| 有持久价值 | 无持久价值 |
|-----------|-----------|
| 构建/测试的前置条件 | 某个 bug 的具体修复代码 |
| 模块间的隐含依赖关系 | 某次 build 失败的具体错误信息 |
| 项目的约定俗成（代码模式） | 某个文件的具体内容 |
| 环境配置要求 | 临时性的调试步骤 |

---

### Tier 3: 跨任务知识整合（Dream）

**做什么**：当 DEVIN.md 积累了足够多的条目后，执行一次整合操作。

**触发条件**（借鉴 Auto Dream 的多阶段门控）：

```
门控 1（便宜检查）：DEVIN.md 存在且非空
门控 2（中等检查）：自上次整合以来执行了 ≥ 3 次 devin 任务
门控 3（贵检查）：DEVIN.md 总条目数 ≥ 20 条
```

三个门控**全部通过**才触发整合。门控 2 需要追踪"自上次整合以来的任务数"，存储在 DEVIN.md 的 frontmatter 中：

```markdown
<!-- devin-meta: {"lastConsolidation": "2026-04-01", "tasksSinceConsolidation": 5} -->
# {项目名} — Devin 知识库
```

**整合操作**：

派一个 Agent 工具执行，prompt：

```markdown
你是 Devin 的知识整合助手。请对以下 DEVIN.md 文件进行整合：

任务：
1. **合并重复** — 找出描述同一件事的多个条目，合并为一条（保留信息量最大的描述）
2. **清理过时** — 检查文件路径是否存在，不存在的标记为待确认
3. **提升结构** — 如果踩坑记录中有多个条目描述同一个主题（如"构建相关"），考虑合并为一条综合描述
4. **更新时间戳** — 更新"最后更新"时间

约束：
- 只读 + 编辑 DEVIN.md，不修改其他文件
- 不删除用户手动添加的条目（标注"(待归类)"的除外，可重新归类）
- 整合后条目总数应减少 20-40%（如果无法减少，说明不需要整合）
- 更新 devin-meta 的 lastConsolidation 和 tasksSinceConsolidation（重置为 0）

输出最后一行：CONSOLIDATED: {合并了 N 条, 清理了 M 条, 当前总计 K 条}
```

**跳过条件**：
- DEVIN.md 总条目数 < 20 → 不需要整合
- 自上次整合以来 < 3 次任务 → 积累不够
- 用户说"不要整合"→ 跳过

---

## 与现有 SPEC 的集成

### 与 SPEC-04（状态持久化）

- `.devin-state.json` schema 从 version 1 升级到 version 2
- 新增 `learnings` 数组字段
- 写入时机不变（仍然 4 个关键节点），但每个节点写入时**附带当前的 learnings**
- 恢复逻辑：compact/中断后恢复时，learnings 也被恢复

### 与 SPEC-06（DEVIN.md 结构化维护）

- Tier 2 提取是 SPEC-06 写入规则的**自动化版本**
- 提取到 DEVIN.md 时遵循 SPEC-06 的所有规则（主键去重、分区归类、条目上限、CLAUDE.md 边界）
- Tier 3 整合是 SPEC-06 全量清理的**增强版本**（不只清理过时条目，还合并重复）

### 与 SPEC-01（验证 Agent）

- 验证 Agent 报 FAIL 后的修复过程会产生 learning（type: gotcha）
- 这些 learning 在 Tier 2 中被评估是否有跨任务价值

---

## 对 SKILL.md 的具体修改

### 1. Phase 3.0 状态初始化（修改现有）

在状态文件 schema 描述中增加 `learnings` 字段说明。

### 2. Phase 3.2 代码修改（新增检查点）

每个文件/模块修改完成后，检查是否有新发现需要记录到 learnings。

### 3. Phase 3.3 验证（新增检查点）

每次 build/test 失败并修复后，将踩坑经验记录到 learnings。

### 4. Phase 3.6 汇报结果（新增 Tier 2 提取）

汇报完成后，自动从 learnings 提取有持久价值的条目到 DEVIN.md。

### 5. Phase 1（新增 Tier 3 整合检查）

每次 `/devin` 触发时，在恢复检查之后、需求理解之前，检查是否满足整合条件。

---

## 边界条件与风险

| 风险 | 应对 |
|------|------|
| Learnings 记录太多导致 .devin-state.json 膨胀 | 每个任务最多 10 条 learnings，每条 content ≤ 200 字 |
| Tier 2 提取判断不准（有价值的没提取，无价值的提取了） | 提取到 DEVIN.md 后仍遵循 SPEC-06 的去重/清理，误提取的条目会在下次局部清理中处理 |
| Tier 3 整合 Agent 改错了 DEVIN.md | Agent 只能编辑 DEVIN.md，不能改其他文件；git 可追溯变更 |
| 整合触发太频繁 | 三阶段门控：≥3 次任务 AND ≥20 条目，且有"不需要整合"的退出条件 |
| devin-meta 注释被用户删除 | 检测到缺失时重新添加，默认 tasksSinceConsolidation = 0 |
| Schema version 升级的兼容性 | version 1 的状态文件正常读取，缺少 learnings 字段视为空数组 |

---

## 验收标准

1. Phase 3.2/3.3/3.4 中，有新发现时 learnings 被正确记录
2. Phase 3.6 后，有跨任务价值的 learnings 被自动提取到 DEVIN.md 对应分区
3. 仅对当前任务有用的 learnings 不被提取到 DEVIN.md
4. 连续 3+ 次任务且 DEVIN.md ≥ 20 条目时，Tier 3 整合被触发
5. 整合后 DEVIN.md 条目数减少（合并重复、清理过时）
6. Session 中断后恢复，learnings 数据不丢失
7. 汇报结果中包含"本次新增 N 条学习笔记，M 条已提取到 DEVIN.md"
