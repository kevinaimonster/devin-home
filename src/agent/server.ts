/**
 * Devin Agent Server
 *
 * Webhook server that receives GitHub @devin mentions. Devin autonomously
 * decides the full workflow: analyze → implement → PR → review → merge → deploy.
 *
 * Run: npx tsx src/agent/server.ts
 */

import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const WORKDIR = process.env.DEVIN_WORKDIR ?? path.join(process.env.HOME ?? "/tmp", "devin-workspaces");
const CONTEXT_DIR = path.join(WORKDIR, ".contexts");

const LLM_BASE_URL = process.env.LLM_BASE_URL ?? "https://api.deepseek.com";
const LLM_API_KEY = process.env.LLM_API_KEY!;
const LLM_MODEL = process.env.LLM_MODEL ?? "deepseek-chat";

const openai = new OpenAI({ baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY });

// ---------------------------------------------------------------------------
// Context persistence
// ---------------------------------------------------------------------------

type Message = { role: "system" | "user" | "assistant"; content: string };

function contextPath(owner: string, repo: string, issueNumber: number): string {
  return path.join(CONTEXT_DIR, `${owner}_${repo}_${issueNumber}.json`);
}

function loadContext(owner: string, repo: string, issueNumber: number): Message[] {
  try { return JSON.parse(fs.readFileSync(contextPath(owner, repo, issueNumber), "utf-8")); }
  catch { return []; }
}

function saveContext(owner: string, repo: string, issueNumber: number, messages: Message[]) {
  fs.mkdirSync(CONTEXT_DIR, { recursive: true });
  fs.writeFileSync(contextPath(owner, repo, issueNumber), JSON.stringify(messages, null, 2));
}

// ---------------------------------------------------------------------------
// GitHub helpers (gh CLI)
// ---------------------------------------------------------------------------

function verifySignature(payload: string, signature: string): boolean {
  if (!WEBHOOK_SECRET) return true;
  const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function gh(cmd: string, timeout = 30000): string {
  try {
    return execSync(cmd, { stdio: "pipe", timeout }).toString().trim();
  } catch (e: any) {
    const stderr = e.stderr?.toString() ?? "";
    console.error(`[devin] gh failed: ${cmd}\n${stderr}`);
    throw e;
  }
}

function ghSafe(cmd: string, timeout = 30000): string {
  try { return gh(cmd, timeout); }
  catch { return ""; }
}

function ghComment(owner: string, repo: string, issueNumber: number, body: string) {
  try {
    const tmpFile = path.join(WORKDIR, `.comment-${Date.now()}.md`);
    fs.mkdirSync(WORKDIR, { recursive: true });
    fs.writeFileSync(tmpFile, body);
    gh(`gh issue comment ${issueNumber} --repo ${owner}/${repo} --body-file ${tmpFile}`);
    fs.unlinkSync(tmpFile);
  } catch (e) {
    console.error(`[devin] Failed to comment:`, e instanceof Error ? e.message : e);
  }
}

function ghReaction(owner: string, repo: string, commentId: number, reaction: string) {
  ghSafe(`gh api repos/${owner}/${repo}/issues/comments/${commentId}/reactions --method POST -f content="${reaction}"`);
}

function ghCreateFile(owner: string, repo: string, filePath: string, content: string, branch: string, message: string) {
  const encoded = Buffer.from(content).toString("base64");
  const sha = ghSafe(`gh api repos/${owner}/${repo}/contents/${filePath}?ref=${branch} --jq .sha`);
  const shaFlag = sha ? `-f sha="${sha}"` : "";
  gh(`gh api repos/${owner}/${repo}/contents/${filePath} --method PUT -f message="${message.replace(/"/g, '\\"')}" -f content="${encoded}" -f branch="${branch}" ${shaFlag}`);
}

// ---------------------------------------------------------------------------
// Code validation
// ---------------------------------------------------------------------------

function validateCode(filePath: string, content: string): string[] {
  const issues: string[] = [];
  const ext = path.extname(filePath).toLowerCase();

  if ([".ts", ".tsx", ".js", ".jsx", ".css", ".html"].includes(ext)) {
    // Bracket matching
    const opens = (content.match(/[{(\[]/g) ?? []).length;
    const closes = (content.match(/[})\]]/g) ?? []).length;
    if (opens !== closes) {
      issues.push(`Bracket mismatch: ${opens} opening vs ${closes} closing`);
    }
  }

  if ([".json"].includes(ext)) {
    try { JSON.parse(content); }
    catch (e) { issues.push(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`); }
  }

  if (content.trim().length === 0) {
    issues.push("File is empty");
  }

  // Check for common LLM artifacts
  if (content.includes("```")) {
    issues.push("Contains markdown code fences — likely raw LLM output");
  }

  return issues;
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

async function chat(messages: Message[]): Promise<string> {
  const response = await openai.chat.completions.create({
    model: LLM_MODEL,
    messages,
    max_tokens: 8192,
    temperature: 0.3,
  });
  return response.choices[0]?.message?.content ?? "";
}

function parseJSON(text: string): any {
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  let cleaned = jsonMatch ? jsonMatch[1]!.trim() : text.trim();
  const braceMatch = cleaned.match(/\{[\s\S]*\}/);
  if (braceMatch) cleaned = braceMatch[0];
  return JSON.parse(cleaned);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function execAction(action: any, owner: string, repo: string, issueNumber: number): string {
  switch (action.action) {
    case "comment":
      ghComment(owner, repo, issueNumber, action.body);
      return "Comment posted.";

    case "create_branch": {
      const mainSha = gh(`gh api repos/${owner}/${repo}/git/ref/heads/main --jq .object.sha`);
      ghSafe(`gh api repos/${owner}/${repo}/git/refs --method POST -f ref="refs/heads/${action.branch}" -f sha="${mainSha}"`);
      return `Branch ${action.branch} created.`;
    }

    case "commit_file": {
      // Validate code before committing
      const issues = validateCode(action.path, action.content);
      if (issues.length > 0) {
        return `Validation failed for ${action.path}: ${issues.join("; ")}. Fix the code and retry.`;
      }
      ghCreateFile(owner, repo, action.path, action.content, action.branch, action.message || `Update ${action.path}`);
      return `Committed ${action.path} to ${action.branch}.`;
    }

    case "commit_files": {
      // Atomic multi-file commit via Git Tree API
      const branch: string = action.branch;
      const files: Array<{ path: string; content: string }> = action.files;

      // Validate all files first
      const allIssues: string[] = [];
      for (const f of files) {
        const issues = validateCode(f.path, f.content);
        if (issues.length > 0) allIssues.push(`${f.path}: ${issues.join("; ")}`);
      }
      if (allIssues.length > 0) {
        return `Validation failed:\n${allIssues.join("\n")}\nFix the code and retry.`;
      }

      // Get base tree
      const baseSha = gh(`gh api repos/${owner}/${repo}/git/ref/heads/${branch} --jq .object.sha`);
      const baseTreeSha = gh(`gh api repos/${owner}/${repo}/git/commits/${baseSha} --jq .tree.sha`);

      // Create blobs and build tree entries
      const treeEntries: string[] = [];
      for (const f of files) {
        const encoded = Buffer.from(f.content).toString("base64");
        const blobSha = gh(`gh api repos/${owner}/${repo}/git/blobs --method POST -f content="${encoded}" -f encoding="base64" --jq .sha`);
        treeEntries.push(`{"path":"${f.path}","mode":"100644","type":"blob","sha":"${blobSha}"}`);
      }

      // Create tree
      const treeJson = `[${treeEntries.join(",")}]`;
      const tmpTreeFile = path.join(WORKDIR, `.tree-${Date.now()}.json`);
      fs.writeFileSync(tmpTreeFile, JSON.stringify({ base_tree: baseTreeSha, tree: JSON.parse(treeJson) }));
      const newTreeSha = gh(`gh api repos/${owner}/${repo}/git/trees --method POST --input ${tmpTreeFile} --jq .sha`);
      fs.unlinkSync(tmpTreeFile);

      // Create commit
      const message = action.message || `Add ${files.length} files\n\nPart of #${issueNumber}`;
      const tmpCommitFile = path.join(WORKDIR, `.commit-${Date.now()}.json`);
      fs.writeFileSync(tmpCommitFile, JSON.stringify({ message, tree: newTreeSha, parents: [baseSha] }));
      const newCommitSha = gh(`gh api repos/${owner}/${repo}/git/commits --method POST --input ${tmpCommitFile} --jq .sha`);
      fs.unlinkSync(tmpCommitFile);

      // Update branch ref
      gh(`gh api repos/${owner}/${repo}/git/refs/heads/${branch} --method PATCH -f sha="${newCommitSha}"`);

      return `Atomically committed ${files.length} files to ${branch}: ${files.map(f => f.path).join(", ")}`;
    }

    case "create_pr": {
      const tmpFile = path.join(WORKDIR, `.pr-body-${Date.now()}.md`);
      fs.writeFileSync(tmpFile, action.body || "");
      const url = gh(`gh pr create --repo ${owner}/${repo} --head ${action.branch} --base main --title "${(action.title || "").replace(/"/g, '\\"')}" --body-file ${tmpFile}`);
      fs.unlinkSync(tmpFile);
      return `PR created: ${url}`;
    }

    case "review_pr": {
      const diff = ghSafe(`gh pr diff ${action.pr_number} --repo ${owner}/${repo}`);
      return `PR #${action.pr_number} diff:\n${diff.slice(0, 4000)}`;
    }

    case "merge_pr": {
      gh(`gh pr merge ${action.pr_number} --repo ${owner}/${repo} --squash --delete-branch`);
      return `PR #${action.pr_number} merged and branch deleted.`;
    }

    case "close_issue": {
      gh(`gh issue close ${issueNumber} --repo ${owner}/${repo} --reason completed`);
      return `Issue #${issueNumber} closed.`;
    }

    case "deploy_pages": {
      ghSafe(`gh api repos/${owner}/${repo}/pages --method POST -f source='{"branch":"main","path":"/"}' 2>/dev/null`);
      const pagesUrl = ghSafe(`gh api repos/${owner}/${repo}/pages --jq .html_url`);
      return pagesUrl ? `GitHub Pages deployed: ${pagesUrl}` : "GitHub Pages deployment initiated.";
    }

    case "read_file": {
      const content = ghSafe(`gh api repos/${owner}/${repo}/contents/${action.path}?ref=${action.ref || "main"} --jq .content | base64 -d`);
      return content ? `Content of ${action.path}:\n${content.slice(0, 8000)}` : `File ${action.path} not found.`;
    }

    case "list_files": {
      const tree = ghSafe(`gh api repos/${owner}/${repo}/git/trees/${action.ref || "main"}?recursive=1 --jq '.tree[] | select(.type=="blob") | .path' | head -100`);
      return `Files:\n${tree}`;
    }

    case "save_memory": {
      // Append to .devin/memory.md on main branch
      const memoryPath = ".devin/memory.md";
      const existing = ghSafe(`gh api repos/${owner}/${repo}/contents/${memoryPath} --jq .content | base64 -d`);
      const timestamp = new Date().toISOString().split("T")[0];
      const newContent = existing
        ? `${existing}\n\n---\n_${timestamp} (Issue #${issueNumber})_\n\n${action.content}`
        : `# Devin Project Memory\n\n---\n_${timestamp} (Issue #${issueNumber})_\n\n${action.content}`;
      ghCreateFile(owner, repo, memoryPath, newContent, "main", `Update project memory from #${issueNumber}`);
      return `Memory saved to ${memoryPath}.`;
    }

    default:
      return `Unknown action: ${action.action}`;
  }
}

// ---------------------------------------------------------------------------
// Core: autonomous agent loop
// ---------------------------------------------------------------------------

// Track active tasks to prevent duplicate processing
const activeTasks = new Set<string>();

async function handleDevinMention(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  request: string;
  isPR: boolean;
  commentId?: number;
}) {
  const { owner, repo, issueNumber, issueTitle, request, isPR, commentId } = params;
  const key = `${owner}/${repo}#${issueNumber}`;

  // Prevent duplicate processing
  if (activeTasks.has(key)) {
    console.log(`[devin] ${key} already being processed, skipping`);
    return;
  }
  activeTasks.add(key);
  const startTime = Date.now();

  console.log(`[devin] Processing: ${key}`);

  // React to the triggering comment with 🚀
  if (commentId) {
    ghReaction(owner, repo, commentId, "rocket");
  }

  try {
    let messages = loadContext(owner, repo, issueNumber);

    if (messages.length === 0) {
      const fileTree = ghSafe(`gh api repos/${owner}/${repo}/git/trees/main?recursive=1 --jq '.tree[] | select(.type=="blob") | .path' | head -100`);
      const projectContext = ghSafe(`gh api repos/${owner}/${repo}/contents/README.md --jq .content | base64 -d`);
      const issueBody = ghSafe(`gh issue view ${issueNumber} --repo ${owner}/${repo} --json body --jq .body`);
      // Load project memory for cross-issue context
      const projectMemory = ghSafe(`gh api repos/${owner}/${repo}/contents/.devin/memory.md --jq .content | base64 -d`);

      messages = [{
        role: "system",
        content: `你是 Devin，一个自主工作的 AI 软件工程师。你可以独立完成从需求分析到部署的完整工作流。

当前项目：${owner}/${repo}
Issue #${issueNumber}：${issueTitle}

文件结构：
${fileTree || "(空项目)"}
${projectContext ? `\n项目说明：\n${projectContext}` : ""}
${projectMemory ? `\n项目记忆（来自 .devin/memory.md，包含跨 Issue 的经验和知识）：\n${projectMemory}` : ""}

## 你可以执行的动作

你每次回复一个 JSON 对象，包含 "actions" 数组和 "done" 标志。系统会依次执行每个 action 并把结果反馈给你，你可以根据结果决定下一步。

可用 actions：
- {"action": "comment", "body": "评论内容"} — 在 Issue 上发评论（用于汇报进度）
- {"action": "create_branch", "branch": "分支名"} — 创建新分支
- {"action": "commit_file", "branch": "分支名", "path": "文件路径", "content": "完整文件内容", "message": "commit 信息"} — 提交单个文件（会做语法校验）
- {"action": "commit_files", "branch": "分支名", "files": [{"path": "路径", "content": "内容"}], "message": "commit 信息"} — 原子提交多个文件（推荐，所有文件在一个 commit 中）
- {"action": "create_pr", "branch": "分支名", "title": "PR标题", "body": "PR描述"} — 创建 PR
- {"action": "review_pr", "pr_number": N} — 读取 PR diff 进行自我审查
- {"action": "merge_pr", "pr_number": N} — 合并 PR（squash merge + 删除分支）
- {"action": "close_issue"} — 关闭 Issue
- {"action": "deploy_pages"} — 启用 GitHub Pages 部署（适合静态网页项目）
- {"action": "read_file", "path": "文件路径", "ref": "分支名"} — 读取仓库中的文件
- {"action": "list_files", "ref": "分支名"} — 列出仓库文件
- {"action": "save_memory", "content": "要记住的内容"} — 追加内容到 .devin/memory.md（跨 Issue 持久记忆，记录项目的技术决策、踩过的坑、部署方式等）

## 输出格式

{"actions": [...], "thinking": "你的思考过程", "done": false}

当 done=true 时，agent 循环结束。

## 工作流程（你自主决定）

典型流程：
1. 先 comment 告知用户你在做什么（第一轮就要评论，让用户看到进度）
2. create_branch → commit_files（推荐用原子提交） → create_pr
3. review_pr 自我审查
4. 审查通过：merge_pr → close_issue → deploy_pages（如适用）
5. 最后 comment 汇报完成情况

如果需求不清晰，comment 提问然后 done=true 等用户回复。

## 项目运维知识维护

完成任务后，检查 README.md 是否包含：部署方式、本地开发、日志查看、环境变量、项目结构。缺失的要补充或提问。

## 关键规则
- 只输出 JSON
- branch 命名：devin/issue-${issueNumber}-简短英文描述
- 代码质量要高，写代码时就确保正确
- 每个文件的 content 必须是完整可用的代码（系统会自动做语法校验，不通过会拒绝提交）
- 优先用 commit_files 原子提交多个文件
- 一轮迭代中尽量批量执行多个 actions
- review_pr 后如果代码没问题，立即在同一轮 merge + close
- 不要反复 read_file 同一个文件
- 如果某个 action 失败了，分析原因后重试或换一种方式`,
      }, {
        role: "user",
        content: `Issue 标题：${issueTitle}\nIssue 内容：${issueBody}\n\n用户请求：${request}`,
      }];
    } else {
      messages.push({
        role: "user",
        content: `用户追加说：${request}`,
      });
    }

    // Agent loop
    const MAX_ITERATIONS = 15;
    let totalActions = 0;
    let failedActions = 0;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      console.log(`[devin] ${key} — iteration ${i + 1}/${MAX_ITERATIONS}`);

      // Auto progress update every 4 iterations
      if (i > 0 && i % 4 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        ghComment(owner, repo, issueNumber, `⏳ 进度更新：已完成 ${totalActions} 个操作（${failedActions} 个失败），耗时 ${elapsed}s，当前第 ${i + 1}/${MAX_ITERATIONS} 轮迭代`);
      }

      const response = await chat(messages);
      messages.push({ role: "assistant", content: response });
      saveContext(owner, repo, issueNumber, messages);

      let parsed: any;
      try {
        parsed = parseJSON(response);
      } catch {
        console.error(`[devin] Failed to parse LLM response:`, response.slice(0, 200));
        // Retry once: tell LLM to fix its output
        messages.push({ role: "user", content: "Your response was not valid JSON. Please respond with a valid JSON object: {\"actions\": [...], \"thinking\": \"...\", \"done\": false}" });
        saveContext(owner, repo, issueNumber, messages);
        continue;
      }

      if (parsed.thinking) {
        console.log(`[devin] Thinking: ${parsed.thinking.slice(0, 120)}`);
      }

      const actions: any[] = parsed.actions ?? [];
      const results: string[] = [];

      for (const action of actions) {
        totalActions++;
        const actionLabel = `${action.action}${action.path ? ` ${action.path}` : ""}${action.pr_number ? ` #${action.pr_number}` : ""}`;

        try {
          console.log(`[devin] Executing: ${actionLabel}`);
          const result = execAction(action, owner, repo, issueNumber);

          // Check if validation failed (returned as result, not thrown)
          if (result.startsWith("Validation failed")) {
            results.push(`⚠ ${action.action}: ${result}`);
            failedActions++;
            console.warn(`[devin] ⚠ ${actionLabel}: validation failed`);
          } else {
            results.push(`✓ ${action.action}: ${result}`);
            console.log(`[devin] ✓ ${actionLabel}`);
          }
        } catch (e) {
          failedActions++;
          const errMsg = e instanceof Error ? e.message : String(e);
          results.push(`✗ ${action.action} failed: ${errMsg}`);
          console.error(`[devin] ✗ ${actionLabel}: ${errMsg}`);
        }
      }

      if (parsed.done === true) {
        // Post completion stats
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(`[devin] ${key} — done (${elapsed}s, ${totalActions} actions, ${failedActions} failed)`);
        break;
      }

      if (results.length > 0) {
        messages.push({
          role: "user",
          content: `Action results:\n${results.join("\n")}\n\nContinue with next actions, or set done=true if finished.`,
        });
        saveContext(owner, repo, issueNumber, messages);
      } else {
        break;
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

    // Check if we exhausted iterations without completing
    const lastMsg = messages[messages.length - 1];
    let didFinish = false;
    if (lastMsg?.role === "assistant") {
      try { didFinish = parseJSON(lastMsg.content).done === true; } catch {}
    }
    if (!didFinish) {
      ghComment(owner, repo, issueNumber,
        `⚠️ 达到最大迭代次数（${MAX_ITERATIONS}轮），任务未完全完成。\n\n已执行 ${totalActions} 个操作（${failedActions} 个失败），耗时 ${elapsed}s。\n\n你可以再次 @devin 让我继续完成剩余工作。`
      );
    }

    console.log(`[devin] Completed: ${key} (${elapsed}s total, finished=${didFinish})`);
  } catch (error) {
    console.error(`[devin] Error: ${key}:`, error);
    ghComment(owner, repo, issueNumber,
      `处理时遇到了错误：\n\n\`\`\`\n${error instanceof Error ? error.message : String(error)}\n\`\`\``
    );
  } finally {
    activeTasks.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Express Server
// ---------------------------------------------------------------------------

const app = express();
app.use(express.text({ type: "application/json", limit: "10mb" }));

// CORS for Dashboard
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (_req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

app.post("/webhook", async (req, res) => {
  const signature = (req.headers["x-hub-signature-256"] as string) ?? "";
  const rawBody = req.body as string;

  if (!verifySignature(rawBody, signature)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const eventType = req.headers["x-github-event"] as string;
  const event = JSON.parse(rawBody);
  res.json({ ok: true });

  if (eventType === "issue_comment" && event.action === "created") {
    const body: string = event.comment?.body ?? "";
    if (!body.toLowerCase().includes("@devin")) return;

    const commenter = event.comment?.user?.login ?? "";
    if (commenter.includes("[bot]")) return;
    if (commenter === "github-actions") return;
    if (body.startsWith("🤖") || body.startsWith("## 📋") || body.startsWith("## ✅") || body.includes("正在处理中") || body.includes("正在分析需求")) return;

    handleDevinMention({
      owner: event.repository.owner.login,
      repo: event.repository.name,
      issueNumber: event.issue.number,
      issueTitle: event.issue.title,
      request: body.replace(/@devin\b/gi, "").trim(),
      isPR: !!event.issue.pull_request,
      commentId: event.comment?.id,
    });
  } else if (eventType === "issues" && event.action === "opened") {
    const body: string = event.issue?.body ?? "";
    if (!body.toLowerCase().includes("@devin")) return;

    handleDevinMention({
      owner: event.repository.owner.login,
      repo: event.repository.name,
      issueNumber: event.issue.number,
      issueTitle: event.issue.title,
      request: body.replace(/@devin\b/gi, "").trim(),
      isPR: false,
    });
  }
});

// ---------------------------------------------------------------------------
// Dashboard API endpoints
// ---------------------------------------------------------------------------

interface TaskSummary {
  owner: string;
  repo: string;
  issueNumber: number;
  messageCount: number;
  lastUpdated: string | null;
  status: "working" | "waiting" | "done" | "error" | "unknown";
  lastAssistantPreview: string;
}

function inferStatus(messages: Message[]): TaskSummary["status"] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      try {
        const parsed = parseJSON(msg.content);
        if (parsed.done === true) return "done";
        if (parsed.actions && parsed.actions.length > 0) return "working";
      } catch {
        if (msg.content.includes("error") || msg.content.includes("failed")) return "error";
      }
      return "working";
    }
  }
  if (messages.length > 0 && messages[messages.length - 1].role === "user") return "waiting";
  return "unknown";
}

function getLastAssistantPreview(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      try {
        const parsed = parseJSON(messages[i].content);
        if (parsed.thinking) return parsed.thinking.slice(0, 120);
        if (parsed.actions && parsed.actions.length > 0) {
          return parsed.actions.map((a: any) => a.action).join(", ");
        }
      } catch {}
      return messages[i].content.slice(0, 120);
    }
  }
  return "";
}

app.get("/api/tasks", (_req, res) => {
  try {
    if (!fs.existsSync(CONTEXT_DIR)) { res.json([]); return; }
    const files = fs.readdirSync(CONTEXT_DIR).filter(f => f.endsWith(".json"));
    const tasks: TaskSummary[] = [];

    for (const file of files) {
      const match = file.replace(".json", "").match(/^(.+?)_(.+?)_(\d+)$/);
      if (!match) continue;
      const [, owner, repo, issueStr] = match;
      const filePath = path.join(CONTEXT_DIR, file);
      let messages: Message[] = [];
      try { messages = JSON.parse(fs.readFileSync(filePath, "utf-8")); }
      catch { continue; }
      const stat = fs.statSync(filePath);
      tasks.push({
        owner: owner!, repo: repo!, issueNumber: parseInt(issueStr!, 10),
        messageCount: messages.length, lastUpdated: stat.mtime.toISOString(),
        status: inferStatus(messages), lastAssistantPreview: getLastAssistantPreview(messages),
      });
    }
    tasks.sort((a, b) => new Date(b.lastUpdated!).getTime() - new Date(a.lastUpdated!).getTime());
    res.json(tasks);
  } catch (e) {
    console.error("[devin] /api/tasks error:", e);
    res.status(500).json({ error: "Failed to list tasks" });
  }
});

app.get("/api/tasks/:owner/:repo/:issueNumber", (req, res) => {
  try {
    const { owner, repo, issueNumber } = req.params;
    const filePath = path.join(CONTEXT_DIR, `${owner}_${repo}_${issueNumber}.json`);
    if (!fs.existsSync(filePath)) { res.status(404).json({ error: "Task not found" }); return; }
    const messages: Message[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const stat = fs.statSync(filePath);
    res.json({
      owner, repo, issueNumber: parseInt(issueNumber!, 10),
      messages, lastUpdated: stat.mtime.toISOString(), status: inferStatus(messages),
    });
  } catch (e) {
    console.error("[devin] /api/tasks/:id error:", e);
    res.status(500).json({ error: "Failed to load task" });
  }
});

app.get("/health", (_req, res) => {
  const contexts = fs.existsSync(CONTEXT_DIR) ? fs.readdirSync(CONTEXT_DIR).length : 0;
  res.json({
    status: "ok",
    activeContexts: contexts,
    activeTasks: Array.from(activeTasks),
    model: LLM_MODEL,
  });
});

app.listen(PORT, () => {
  console.log(`[devin] Server running on port ${PORT}`);
  console.log(`[devin] Model: ${LLM_MODEL} @ ${LLM_BASE_URL}`);
  console.log(`[devin] Workdir: ${WORKDIR}`);
});
