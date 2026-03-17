/**
 * Devin Agent Server
 *
 * Webhook server that receives GitHub @devin mentions. Devin autonomously
 * decides the full workflow: analyze → implement → PR → review → merge → deploy.
 *
 * Uses GitHub App Installation Token + REST API (no gh CLI dependency).
 *
 * Run: npx tsx src/agent/server.ts
 */

import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
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

const GITHUB_APP_ID = process.env.GITHUB_APP_ID!;
const GITHUB_APP_PRIVATE_KEY = (process.env.GITHUB_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");

const ALLOWED_ACCOUNTS = (process.env.ALLOWED_ACCOUNTS ?? "")
  .split(",")
  .map(a => a.trim().toLowerCase())
  .filter(Boolean);

const openai = new OpenAI({ baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY });

// ---------------------------------------------------------------------------
// GitHub App Authentication
// ---------------------------------------------------------------------------

function generateJWT(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60,
    exp: now + 600,
    iss: GITHUB_APP_ID,
  })).toString("base64url");
  const signing = crypto.createSign("RSA-SHA256");
  signing.update(`${header}.${payload}`);
  const signature = signing.sign(GITHUB_APP_PRIVATE_KEY, "base64url");
  return `${header}.${payload}.${signature}`;
}

const tokenCache = new Map<number, { token: string; expiresAt: number }>();

async function getInstallationToken(installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cached.token;
  }
  const jwt = generateJWT();
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to get installation token: ${res.status} ${err}`);
  }
  const data = await res.json() as { token: string; expires_at: string };
  tokenCache.set(installationId, {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  });
  return data.token;
}

async function githubApi(
  installationId: number,
  method: string,
  endpoint: string,
  body?: any
): Promise<any> {
  const token = await getInstallationToken(installationId);
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub API ${method} ${endpoint}: ${res.status} ${err}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/** Like githubApi but returns null instead of throwing on error */
async function githubApiSafe(
  installationId: number,
  method: string,
  endpoint: string,
  body?: any
): Promise<any> {
  try {
    return await githubApi(installationId, method, endpoint, body);
  } catch (e) {
    console.error(`[devin] githubApiSafe failed: ${method} ${endpoint}`, e instanceof Error ? e.message : e);
    return null;
  }
}

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
// GitHub helpers
// ---------------------------------------------------------------------------

function verifySignature(payload: string, signature: string): boolean {
  if (!WEBHOOK_SECRET) return true;
  const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

const DEVIN_SIGNATURE = "\n\n---\n<sub>🤖 *This comment was posted by Devin, an AI agent. Not a human.*</sub>";

async function ghComment(installationId: number, owner: string, repo: string, issueNumber: number, body: string) {
  try {
    await githubApi(installationId, "POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      body: body + DEVIN_SIGNATURE,
    });
  } catch (e) {
    console.error(`[devin] Failed to comment:`, e instanceof Error ? e.message : e);
  }
}

async function ghReaction(installationId: number, owner: string, repo: string, commentId: number, reaction: string) {
  await githubApiSafe(installationId, "POST", `/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`, {
    content: reaction,
  });
}

async function ghCreateFile(installationId: number, owner: string, repo: string, filePath: string, content: string, branch: string, message: string) {
  const encoded = Buffer.from(content).toString("base64");
  // Try to get existing file SHA
  let sha: string | undefined;
  const existing = await githubApiSafe(installationId, "GET", `/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`);
  if (existing && existing.sha) {
    sha = existing.sha;
  }
  const payload: Record<string, string> = { message, content: encoded, branch };
  if (sha) payload.sha = sha;
  await githubApi(installationId, "PUT", `/repos/${owner}/${repo}/contents/${filePath}`, payload);
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

  return issues;
}

/** Strip markdown code fences that LLMs sometimes wrap code in */
function cleanLLMCode(content: string): string {
  // Remove wrapping ```lang\n...\n```
  const match = content.match(/^```(?:\w+)?\s*\n([\s\S]*?)\n```\s*$/);
  if (match) return match[1]!;
  // Remove leading/trailing ``` without language
  return content.replace(/^```\s*\n?/, "").replace(/\n?```\s*$/, "");
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

async function chat(messages: Message[]): Promise<string> {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: LLM_MODEL,
        messages,
        max_tokens: 8192,
        temperature: 0.3,
      });
      return response.choices[0]?.message?.content ?? "";
    } catch (e) {
      console.error(`[devin] LLM call failed (attempt ${attempt}/${MAX_RETRIES}):`, e instanceof Error ? e.message : e);
      if (attempt === MAX_RETRIES) throw e;
      await new Promise(r => setTimeout(r, attempt * 3000)); // 3s, 6s, 9s
    }
  }
  throw new Error("LLM call failed after retries");
}

function parseJSON(text: string): any {
  // Try direct parse first
  try { return JSON.parse(text.trim()); } catch {}
  // Try extracting from markdown code block
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1]!.trim()); } catch {}
  }
  // Try finding outermost braces
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch {}
  }
  // Last resort: try fixing common issues (trailing commas, unescaped newlines in strings)
  const cleaned = text.replace(/,\s*([\]}])/g, "$1");
  const braceMatch2 = cleaned.match(/\{[\s\S]*\}/);
  if (braceMatch2) {
    return JSON.parse(braceMatch2[0]);
  }
  throw new Error("Could not parse JSON from response");
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function execAction(action: any, installationId: number, owner: string, repo: string, issueNumber: number): Promise<string> {
  switch (action.action) {
    case "comment":
      await ghComment(installationId, owner, repo, issueNumber, action.body);
      return "Comment posted.";

    case "create_branch": {
      // Create branch by committing a marker file via Contents API
      const markerPath = `.devin/.branch-${Date.now()}`;
      const markerContent = Buffer.from(`Branch created for #${issueNumber}`).toString("base64");
      try {
        await githubApi(installationId, "PUT", `/repos/${owner}/${repo}/contents/${markerPath}`, {
          message: `Create branch ${action.branch}`,
          content: markerContent,
          branch: action.branch,
        });
        // Clean up marker file
        const markerData = await githubApiSafe(installationId, "GET", `/repos/${owner}/${repo}/contents/${markerPath}?ref=${action.branch}`);
        if (markerData && markerData.sha) {
          await githubApiSafe(installationId, "DELETE", `/repos/${owner}/${repo}/contents/${markerPath}`, {
            message: "Clean up",
            sha: markerData.sha,
            branch: action.branch,
          });
        }
      } catch {
        // Fallback: try git/refs API
        const refData = await githubApi(installationId, "GET", `/repos/${owner}/${repo}/git/ref/heads/main`);
        const mainSha = refData.object.sha;
        await githubApi(installationId, "POST", `/repos/${owner}/${repo}/git/refs`, {
          ref: `refs/heads/${action.branch}`,
          sha: mainSha,
        });
      }
      return `Branch ${action.branch} created.`;
    }

    case "commit_file": {
      const cleaned = cleanLLMCode(action.content);
      const issues = validateCode(action.path, cleaned);
      if (issues.length > 0) {
        return `Validation failed for ${action.path}: ${issues.join("; ")}. Fix the code and retry.`;
      }
      await ghCreateFile(installationId, owner, repo, action.path, cleaned, action.branch, action.message || `Update ${action.path}`);
      return `Committed ${action.path} to ${action.branch}.`;
    }

    case "commit_files": {
      const branch: string = action.branch;
      const files: Array<{ path: string; content: string }> = action.files.map(
        (f: any) => ({ path: f.path, content: cleanLLMCode(f.content) })
      );

      const allIssues: string[] = [];
      for (const f of files) {
        const issues = validateCode(f.path, f.content);
        if (issues.length > 0) allIssues.push(`${f.path}: ${issues.join("; ")}`);
      }
      if (allIssues.length > 0) {
        return `Validation failed:\n${allIssues.join("\n")}\nFix the code and retry.`;
      }

      // Commit files one by one via Contents API
      const committed: string[] = [];
      for (const f of files) {
        try {
          await ghCreateFile(installationId, owner, repo, f.path, f.content, branch, action.message || `Update ${f.path}\n\nPart of #${issueNumber}`);
          committed.push(f.path);
        } catch (e) {
          return `Failed at ${f.path} (${committed.length}/${files.length} committed): ${e instanceof Error ? e.message : e}`;
        }
      }

      return `Committed ${files.length} files to ${branch}: ${committed.join(", ")}`;
    }

    case "create_pr": {
      const result = await githubApi(installationId, "POST", `/repos/${owner}/${repo}/pulls`, {
        head: action.branch,
        base: "main",
        title: action.title || "",
        body: action.body || "",
      });
      return `PR created: ${result.html_url}`;
    }

    case "review_pr": {
      const filesData = await githubApiSafe(installationId, "GET", `/repos/${owner}/${repo}/pulls/${action.pr_number}/files`);
      if (!filesData || filesData.length === 0) return `PR #${action.pr_number}: no diff found.`;

      // Build diff text from files data
      const diffParts: string[] = [];
      for (const file of filesData) {
        if (file.patch) {
          diffParts.push(`--- ${file.filename}\n${file.patch}`);
        }
      }
      const diff = diffParts.join("\n\n");
      if (!diff) return `PR #${action.pr_number}: no diff found.`;

      // Use LLM to do a structured code review
      const reviewPrompt: Message[] = [
        { role: "system", content: `你是一个代码审查专家。审查以下 PR diff，检查：
1. 逻辑错误（变量未定义、函数未调用、条件错误）
2. 语法问题（括号不匹配、缺少分号等）
3. 安全问题（XSS、注入等）
4. 代码风格（命名、缩进一致性）
5. 缺失的边界处理

输出 JSON：{"passed": true/false, "issues": ["问题描述"], "summary": "总结"}
只输出 JSON。` },
        { role: "user", content: `PR Diff:\n${diff.slice(0, 6000)}` },
      ];
      const reviewResult = await chat(reviewPrompt);
      return `PR #${action.pr_number} review result:\n${reviewResult}`;
    }

    case "merge_pr": {
      await githubApi(installationId, "PUT", `/repos/${owner}/${repo}/pulls/${action.pr_number}/merge`, {
        merge_method: "squash",
      });
      // Delete the branch after merge
      try {
        const prData = await githubApi(installationId, "GET", `/repos/${owner}/${repo}/pulls/${action.pr_number}`);
        if (prData && prData.head && prData.head.ref) {
          await githubApiSafe(installationId, "DELETE", `/repos/${owner}/${repo}/git/refs/heads/${prData.head.ref}`);
        }
      } catch {}
      return `PR #${action.pr_number} merged and branch deleted.`;
    }

    case "close_issue": {
      await githubApi(installationId, "PATCH", `/repos/${owner}/${repo}/issues/${issueNumber}`, {
        state: "closed",
        state_reason: "completed",
      });
      return `Issue #${issueNumber} closed.`;
    }

    case "deploy_pages": {
      await githubApiSafe(installationId, "POST", `/repos/${owner}/${repo}/pages`, {
        source: { branch: "main", path: "/" },
      });
      const pagesData = await githubApiSafe(installationId, "GET", `/repos/${owner}/${repo}/pages`);
      const pagesUrl = pagesData?.html_url;
      return pagesUrl ? `GitHub Pages deployed: ${pagesUrl}` : "GitHub Pages deployment initiated.";
    }

    case "read_file": {
      const data = await githubApiSafe(installationId, "GET", `/repos/${owner}/${repo}/contents/${action.path}?ref=${action.ref || "main"}`);
      if (data && data.content) {
        const content = Buffer.from(data.content, "base64").toString("utf-8");
        return `Content of ${action.path}:\n${content.slice(0, 8000)}`;
      }
      return `File ${action.path} not found.`;
    }

    case "list_files": {
      const treeData = await githubApiSafe(installationId, "GET", `/repos/${owner}/${repo}/git/trees/${action.ref || "main"}?recursive=1`);
      if (treeData && treeData.tree) {
        const files = treeData.tree
          .filter((item: any) => item.type === "blob")
          .map((item: any) => item.path)
          .slice(0, 100);
        return `Files:\n${files.join("\n")}`;
      }
      return "Files: (empty or not found)";
    }

    case "save_memory": {
      // Append to .devin/memory.md on main branch
      const memoryPath = ".devin/memory.md";
      const existingData = await githubApiSafe(installationId, "GET", `/repos/${owner}/${repo}/contents/${memoryPath}`);
      let existing = "";
      if (existingData && existingData.content) {
        existing = Buffer.from(existingData.content, "base64").toString("utf-8");
      }
      const timestamp = new Date().toISOString().split("T")[0];
      const newContent = existing
        ? `${existing}\n\n---\n_${timestamp} (Issue #${issueNumber})_\n\n${action.content}`
        : `# Devin Project Memory\n\n---\n_${timestamp} (Issue #${issueNumber})_\n\n${action.content}`;
      await ghCreateFile(installationId, owner, repo, memoryPath, newContent, "main", `Update project memory from #${issueNumber}`);
      return `Memory saved to ${memoryPath}.`;
    }

    default:
      return `Unknown action: ${action.action}`;
  }
}

// ---------------------------------------------------------------------------
// Task queue
// ---------------------------------------------------------------------------

interface QueuedTask {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  request: string;
  isPR: boolean;
  commentId?: number;
}

const taskQueue: QueuedTask[] = [];
const activeTasks = new Set<string>();
const rateLimitMap = new Map<string, number>(); // key → last trigger timestamp
const RATE_LIMIT_MS = 60_000; // 60 seconds cooldown per issue

function enqueueTask(task: QueuedTask) {
  // Handle --help
  if (task.request.trim() === "--help" || task.request.trim() === "help") {
    ghComment(task.installationId, task.owner, task.repo, task.issueNumber, HELP_TEXT);
    return;
  }

  const key = `${task.owner}/${task.repo}#${task.issueNumber}`;

  // Rate limiting
  const lastTrigger = rateLimitMap.get(key) ?? 0;
  if (Date.now() - lastTrigger < RATE_LIMIT_MS) {
    console.log(`[devin] ${key} rate limited (${Math.round((RATE_LIMIT_MS - (Date.now() - lastTrigger)) / 1000)}s cooldown remaining)`);
    return;
  }
  rateLimitMap.set(key, Date.now());

  if (activeTasks.has(key)) {
    console.log(`[devin] ${key} active, queuing for later`);
    taskQueue.push(task);
    return;
  }
  processTask(task);
}

const HELP_TEXT = `## 🤖 Devin — AI 软件工程师

**使用方式**：在 Issue 或 PR 中 \`@devin\` + 你的需求

### 示例
- \`@devin 创建一个登录页面\`
- \`@devin 修复这个 bug\`
- \`@devin --no-merge 添加搜索功能\`（只提 PR，不自动合并）
- \`@devin --draft 重构用户模块\`（创建 Draft PR）

### 控制参数
| 参数 | 效果 |
|------|------|
| \`--no-merge\` | 创建 PR 但不自动合并 |
| \`--draft\` | 创建 Draft PR |
| \`--no-close\` | 完成后不关闭 Issue |
| \`--help\` | 显示本帮助 |

### 工作流程
1. 分析需求（不清晰会提问）
2. 制定方案并在 Issue 评论
3. 创建分支 → 编码 → 提交
4. 自我审查代码质量
5. 合并 PR → 部署 → 关闭 Issue

每 4 轮迭代会汇报进度，完成后会发送统计报告。

[Dashboard](https://devin-blush.vercel.app) | [能力说明](https://github.com/kevinaimonster/devin-home/blob/main/docs/DEVIN-CAPABILITIES.md)`;


async function processTask(task: QueuedTask) {
  await handleDevinMention(task);
  // After finishing, check if there's a queued task for the same or different issue
  if (taskQueue.length > 0) {
    const next = taskQueue.shift()!;
    console.log(`[devin] Processing next queued task: ${next.owner}/${next.repo}#${next.issueNumber}`);
    processTask(next);
  }
}

// ---------------------------------------------------------------------------
// User directive parsing
// ---------------------------------------------------------------------------

interface UserDirectives {
  noMerge: boolean;   // --no-merge: create PR but don't auto-merge
  draft: boolean;     // --draft: create draft PR
  noClose: boolean;   // --no-close: don't close issue after merge
  request: string;    // the actual request without directives
}

function parseDirectives(raw: string): UserDirectives {
  const directives: UserDirectives = { noMerge: false, draft: false, noClose: false, request: raw };
  directives.noMerge = /--no-?merge/i.test(raw);
  directives.draft = /--draft/i.test(raw);
  directives.noClose = /--no-?close/i.test(raw);
  directives.request = raw.replace(/--no-?merge|--draft|--no-?close/gi, "").trim();
  return directives;
}

// ---------------------------------------------------------------------------
// Smart context collection
// ---------------------------------------------------------------------------

async function collectProjectContext(installationId: number, owner: string, repo: string): Promise<string> {
  const parts: string[] = [];

  // package.json — framework, dependencies
  const pkgData = await githubApiSafe(installationId, "GET", `/repos/${owner}/${repo}/contents/package.json`);
  if (pkgData && pkgData.content) {
    try {
      const pkgJson = Buffer.from(pkgData.content, "base64").toString("utf-8");
      const pkg = JSON.parse(pkgJson);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const depNames = Object.keys(deps).slice(0, 30).join(", ");
      parts.push(`Framework/Dependencies: ${depNames}`);
      if (pkg.scripts) parts.push(`Scripts: ${Object.keys(pkg.scripts).join(", ")}`);
    } catch {}
  }

  // tsconfig.json — TypeScript config
  const tsData = await githubApiSafe(installationId, "GET", `/repos/${owner}/${repo}/contents/tsconfig.json`);
  if (tsData && tsData.content) parts.push("TypeScript project detected.");

  // .devin/config.yml — custom Devin config (future)
  const devinData = await githubApiSafe(installationId, "GET", `/repos/${owner}/${repo}/contents/.devin/config.yml`);
  if (devinData && devinData.content) {
    const devinConfig = Buffer.from(devinData.content, "base64").toString("utf-8");
    parts.push(`Devin config:\n${devinConfig}`);
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Context compaction — summarize old messages to keep context manageable
// ---------------------------------------------------------------------------

async function compactContext(messages: Message[]): Promise<Message[]> {
  // Only compact if we have more than 14 messages
  if (messages.length <= 14) return messages;

  // Keep system prompt and last 8 messages (more context = fewer mistakes)
  const systemMsg = messages[0];
  const recentMessages = messages.slice(-8);
  const oldMessages = messages.slice(1, -8);

  const summary = await chat([
    { role: "system", content: "Summarize the following conversation into a concise summary. Focus on: what was successfully done (files created, PRs created with numbers, merges). Ignore failed attempts and errors — only summarize successes. Output plain text, max 300 words." },
    { role: "user", content: oldMessages.map(m => `[${m.role}]: ${m.content.slice(0, 400)}`).join("\n\n") },
  ]);

  console.log(`[devin] Context compacted: ${messages.length} → ${10} messages`);

  return [
    systemMsg,
    { role: "user", content: `[Previous work summary]\n\n${summary}` },
    { role: "assistant", content: '{"actions": [], "thinking": "Understood. Ready to continue.", "done": false}' },
    ...recentMessages,
  ];
}

// ---------------------------------------------------------------------------
// Core: autonomous agent loop
// ---------------------------------------------------------------------------

async function handleDevinMention(task: QueuedTask) {
  const { installationId, owner, repo, issueNumber, issueTitle, isPR, commentId } = task;
  const directives = parseDirectives(task.request);
  const request = directives.request;
  const key = `${owner}/${repo}#${issueNumber}`;

  activeTasks.add(key);
  const startTime = Date.now();

  console.log(`[devin] Processing: ${key}${directives.noMerge ? " (no-merge)" : ""}${directives.draft ? " (draft)" : ""}`);

  if (commentId) {
    await ghReaction(installationId, owner, repo, commentId, "rocket");
  }

  try {
    let messages = loadContext(owner, repo, issueNumber);

    if (messages.length === 0) {
      // Get file tree
      const treeData = await githubApiSafe(installationId, "GET", `/repos/${owner}/${repo}/git/trees/main?recursive=1`);
      let fileTree = "(空项目)";
      if (treeData && treeData.tree) {
        fileTree = treeData.tree
          .filter((item: any) => item.type === "blob")
          .map((item: any) => item.path)
          .slice(0, 100)
          .join("\n");
      }

      // Get README
      const readmeData = await githubApiSafe(installationId, "GET", `/repos/${owner}/${repo}/contents/README.md`);
      let projectContext = "";
      if (readmeData && readmeData.content) {
        projectContext = Buffer.from(readmeData.content, "base64").toString("utf-8");
      }

      // Get issue body
      const issueData = await githubApiSafe(installationId, "GET", `/repos/${owner}/${repo}/issues/${issueNumber}`);
      const issueBody = issueData?.body ?? "";

      // Get project memory
      const memoryData = await githubApiSafe(installationId, "GET", `/repos/${owner}/${repo}/contents/.devin/memory.md`);
      let projectMemory = "";
      if (memoryData && memoryData.content) {
        projectMemory = Buffer.from(memoryData.content, "base64").toString("utf-8");
      }

      const techContext = await collectProjectContext(installationId, owner, repo);

      messages = [{
        role: "system",
        content: `你是 Devin，一个自主工作的 AI 软件工程师。你可以独立完成从需求分析到部署的完整工作流。

当前项目：${owner}/${repo}
Issue #${issueNumber}：${issueTitle}

文件结构：
${fileTree || "(空项目)"}
${projectContext ? `\n项目说明：\n${projectContext}` : ""}
${projectMemory ? `\n项目记忆（来自 .devin/memory.md，包含跨 Issue 的经验和知识）：\n${projectMemory}` : ""}
${techContext ? `\n技术栈信息：\n${techContext}` : ""}
${directives.noMerge ? "\n⚠️ 用户指令：--no-merge，创建 PR 后不要自动合并，等人类 review。" : ""}
${directives.draft ? "\n⚠️ 用户指令：--draft，创建 Draft PR。" : ""}
${directives.noClose ? "\n⚠️ 用户指令：--no-close，不要关闭 Issue。" : ""}

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

对于复杂任务（超过 3 个文件或涉及修改已有代码），采用两阶段方式：
- 第一阶段：先用 comment 发布设计方案（包含文件清单、关键函数、数据流）
- 第二阶段：按设计方案逐个生成文件
这样可以让你先理清思路，减少一次性生成大量代码时的出错率。

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
- 如果某个 action 失败了，分析原因后重试或换一种方式
- 修改已有文件时：必须先 read_file 读取当前内容，理解后再生成完整的新版本。不要凭记忆修改
- 生成代码时注意：不要在 content 中包含 markdown 代码块标记（系统会自动清理，但最好从源头避免）
- 写代码时遵循项目已有的代码风格（从技术栈信息和文件内容推断）`,
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
        await ghComment(installationId, owner, repo, issueNumber, `⏳ 进度更新：已完成 ${totalActions} 个操作（${failedActions} 个失败），耗时 ${elapsed}s，当前第 ${i + 1}/${MAX_ITERATIONS} 轮迭代`);
      }

      // Compact context if conversation is getting long
      messages = await compactContext(messages);

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
          const result = await execAction(action, installationId, owner, repo, issueNumber);

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
      await ghComment(installationId, owner, repo, issueNumber,
        `⚠️ 达到最大迭代次数（${MAX_ITERATIONS}轮），任务未完全完成。\n\n已执行 ${totalActions} 个操作（${failedActions} 个失败），耗时 ${elapsed}s。\n\n你可以再次 @devin 让我继续完成剩余工作。`
      );
    } else {
      // Auto-generate structured completion report
      const actionLog = messages
        .filter(m => m.role === "user" && m.content.startsWith("Action results:"))
        .flatMap(m => m.content.split("\n").filter(l => l.startsWith("✓") || l.startsWith("✗")))
        .slice(-15);

      const report = [
        `## 🤖 任务完成`,
        ``,
        `| 指标 | 值 |`,
        `|------|-----|`,
        `| 耗时 | ${elapsed}s |`,
        `| 总操作 | ${totalActions} |`,
        `| 失败 | ${failedActions} |`,
        `| 迭代轮数 | ${messages.filter(m => m.role === "assistant").length} |`,
        ``,
        actionLog.length > 0 ? `### 操作记录\n${actionLog.map(l => `- ${l}`).join("\n")}` : "",
      ].filter(Boolean).join("\n");

      await ghComment(installationId, owner, repo, issueNumber, report);
    }

    console.log(`[devin] Completed: ${key} (${elapsed}s total, finished=${didFinish})`);
  } catch (error) {
    console.error(`[devin] Error: ${key}:`, error);
    await ghComment(installationId, owner, repo, issueNumber,
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

  // Whitelist check
  const repoOwner = event.repository?.owner?.login?.toLowerCase() ?? "";
  if (ALLOWED_ACCOUNTS.length > 0 && repoOwner && !ALLOWED_ACCOUNTS.includes(repoOwner)) {
    console.log(`[devin] ${repoOwner} not in whitelist, ignoring`);
    return;
  }

  // Handle installation events (log only)
  if (eventType === "installation") {
    const action = event.action; // created, deleted, etc.
    const account = event.installation?.account?.login ?? "unknown";
    const installationId = event.installation?.id;
    console.log(`[devin] Installation event: ${action} by ${account} (installation ${installationId})`);
    return;
  }

  // Extract installation ID from webhook event
  const installationId: number | undefined = event.installation?.id;
  if (!installationId) {
    console.log(`[devin] No installation ID in webhook event, ignoring`);
    return;
  }

  if (eventType === "issue_comment" && event.action === "created") {
    const body: string = event.comment?.body ?? "";
    if (!body.toLowerCase().includes("@devin")) return;

    const commenter = event.comment?.user?.login ?? "";
    if (commenter.includes("[bot]")) return;
    if (commenter === "github-actions") return;
    if (body.startsWith("🤖") || body.startsWith("## 📋") || body.startsWith("## ✅") || body.includes("正在处理中") || body.includes("正在分析需求") || body.includes("posted by Devin, an AI agent")) return;

    enqueueTask({
      installationId,
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

    enqueueTask({
      installationId,
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
    queuedTasks: taskQueue.length,
    model: LLM_MODEL,
  });
});

app.listen(PORT, () => {
  console.log(`[devin] Server running on port ${PORT}`);
  console.log(`[devin] Model: ${LLM_MODEL} @ ${LLM_BASE_URL}`);
  console.log(`[devin] GitHub App ID: ${GITHUB_APP_ID}`);
  console.log(`[devin] Allowed accounts: ${ALLOWED_ACCOUNTS.length > 0 ? ALLOWED_ACCOUNTS.join(", ") : "(all)"}`);
  console.log(`[devin] Workdir: ${WORKDIR}`);
});
