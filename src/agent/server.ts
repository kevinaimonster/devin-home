/**
 * Devin Agent Server
 *
 * A lightweight webhook server that receives GitHub events and dispatches
 * Claude Code sessions via the Agent SDK. Each Issue maps to a persistent
 * session that can be resumed across multiple @devin interactions.
 *
 * Run: npx tsx src/agent/server.ts
 */

import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const WORKDIR = process.env.DEVIN_WORKDIR ?? path.join(process.env.HOME ?? "/tmp", "devin-workspaces");
const SESSION_MAP_PATH = path.join(WORKDIR, ".session-map.json");

// ---------------------------------------------------------------------------
// Session Map: Issue → Claude Code session ID
// ---------------------------------------------------------------------------

type SessionMap = Record<string, string>; // "owner/repo#123" → sessionId

function loadSessionMap(): SessionMap {
  try {
    return JSON.parse(fs.readFileSync(SESSION_MAP_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveSessionMap(map: SessionMap) {
  fs.mkdirSync(path.dirname(SESSION_MAP_PATH), { recursive: true });
  fs.writeFileSync(SESSION_MAP_PATH, JSON.stringify(map, null, 2));
}

function issueKey(owner: string, repo: string, issueNumber: number): string {
  return `${owner}/${repo}#${issueNumber}`;
}

// ---------------------------------------------------------------------------
// GitHub Helpers (via gh CLI — no Octokit dependency)
// ---------------------------------------------------------------------------

function verifySignature(payload: string, signature: string): boolean {
  if (!WEBHOOK_SECRET) return true;
  const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function ghComment(owner: string, repo: string, issueNumber: number, body: string) {
  try {
    execSync(`gh issue comment ${issueNumber} --repo ${owner}/${repo} --body ${JSON.stringify(body)}`, {
      stdio: "pipe",
      timeout: 30000,
    });
  } catch (e) {
    console.error(`[devin] Failed to comment on ${owner}/${repo}#${issueNumber}:`, e);
  }
}

function ghGetComments(owner: string, repo: string, issueNumber: number): string {
  try {
    const out = execSync(
      `gh api repos/${owner}/${repo}/issues/${issueNumber}/comments --jq '.[].body' 2>/dev/null | tail -20`,
      { stdio: "pipe", timeout: 15000 },
    );
    return out.toString().trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Core: Dispatch Claude Code session
// ---------------------------------------------------------------------------

async function handleDevinMention(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  request: string;
  isPR: boolean;
  conversationHistory: string;
}) {
  const { owner, repo, issueNumber, issueTitle, request, isPR, conversationHistory } = params;
  const key = issueKey(owner, repo, issueNumber);
  const sessionMap = loadSessionMap();
  const existingSessionId = sessionMap[key];

  // Prepare workspace: clone or pull the repo
  const repoDir = path.join(WORKDIR, owner, repo);
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    fs.mkdirSync(repoDir, { recursive: true });
    execSync(`git clone https://github.com/${owner}/${repo}.git ${repoDir}`, { stdio: "pipe" });
  } else {
    try {
      execSync("git fetch origin && git checkout main && git pull origin main", { cwd: repoDir, stdio: "pipe" });
    } catch {
      console.log(`[devin] Git pull failed for ${key}, continuing with existing state`);
    }
  }

  const prompt = buildPrompt({ issueNumber, issueTitle, request, isPR, conversationHistory, owner, repo });

  console.log(`[devin] Processing: ${key} (session: ${existingSessionId ?? "new"})`);

  ghComment(owner, repo, issueNumber, "收到！正在处理中...");

  let sessionId: string | undefined;
  let result = "";

  try {
    const queryOptions: Parameters<typeof query>[0] = {
      prompt,
      options: {
        cwd: repoDir,
        allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"],
        permissionMode: "bypassPermissions" as const,
        allowDangerouslySkipPermissions: true,
        maxTurns: 50,
        systemPrompt: buildSystemPrompt(owner, repo, issueNumber),
        ...(existingSessionId ? { resume: existingSessionId } : {}),
      },
    };

    for await (const message of query(queryOptions)) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        sessionMap[key] = sessionId;
        saveSessionMap(sessionMap);
      }
      if ("result" in message) {
        result = message.result;
      }
    }

    if (result) {
      ghComment(owner, repo, issueNumber, result);
    }

    console.log(`[devin] Completed: ${key}`);
  } catch (error) {
    console.error(`[devin] Error processing ${key}:`, error);
    ghComment(
      owner,
      repo,
      issueNumber,
      `处理时遇到了错误：\n\n\`\`\`\n${error instanceof Error ? error.message : String(error)}\n\`\`\``,
    );
  }
}

function buildSystemPrompt(owner: string, repo: string, issueNumber: number): string {
  return `你是 Devin，一个 AI 软件工程师，在 GitHub 上以 bot 身份工作。

你的身份：
- 你通过 GitHub Issue 和 PR 与用户交互
- 当前在处理 ${owner}/${repo}#${issueNumber}

你的工作流程：
1. 分析需求，如果不清晰就输出需要澄清的问题（用户会在 Issue 里回复，你会被再次调用）
2. 制定实施方案
3. 编写代码并确保质量
4. 创建新的 git branch（命名: devin/issue-${issueNumber}-xxx）
5. 提交代码并 push
6. 用 gh CLI 创建 PR（gh pr create）
7. 在最终输出中汇报你做了什么

关键规则：
- 始终在新 branch 上工作，不要直接提交到 main
- 用 gh CLI 创建 PR 和评论，不要用 API
- 你可以跑测试来验证代码
- 如果需求不清晰，直接输出问题列表，不要猜测
- 输出结果用中文

你可以使用的工具：文件读写、代码编辑、Shell 命令（git, gh, npm 等）、文件搜索。`;
}

function buildPrompt(params: {
  issueNumber: number;
  issueTitle: string;
  request: string;
  isPR: boolean;
  conversationHistory: string;
  owner: string;
  repo: string;
}): string {
  const { issueNumber, issueTitle, request, isPR, conversationHistory } = params;

  if (isPR) {
    return `用户在 PR #${issueNumber} 上 @devin 了你。

PR 标题：${issueTitle}
用户说：${request}

请根据用户的反馈修改代码，推送到当前 PR 的 branch 上。`;
  }

  let prompt = `用户在 Issue #${issueNumber} 上 @devin 了你。

Issue 标题：${issueTitle}
用户请求：${request}`;

  if (conversationHistory) {
    prompt += `\n\n之前的对话记录：\n${conversationHistory}`;
  }

  prompt += `\n\n请分析需求并完成工作。如果需求明确，创建 branch、编写代码、push 并创建 PR。如果需求不清晰，输出你需要澄清的问题。

完成后请用以下格式输出结果：
- 你做了什么
- 修改了哪些文件
- PR 链接（如果创建了）`;

  return prompt;
}

// ---------------------------------------------------------------------------
// Express Server
// ---------------------------------------------------------------------------

const app = express();
app.use(express.text({ type: "application/json", limit: "10mb" }));

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
    if (event.comment?.user?.login?.includes("[bot]")) return;
    if (event.comment?.user?.login === "github-actions") return;

    const owner = event.repository.owner.login;
    const repo = event.repository.name;
    const issueNumber = event.issue.number;
    const conversationHistory = ghGetComments(owner, repo, issueNumber);

    handleDevinMention({
      owner,
      repo,
      issueNumber,
      issueTitle: event.issue.title,
      request: body.replace(/@devin\b/gi, "").trim(),
      isPR: !!event.issue.pull_request,
      conversationHistory,
    });
  } else if (eventType === "issues" && event.action === "opened") {
    const body: string = event.issue?.body ?? "";
    if (!body.toLowerCase().includes("@devin")) return;

    const owner = event.repository.owner.login;
    const repo = event.repository.name;

    handleDevinMention({
      owner,
      repo,
      issueNumber: event.issue.number,
      issueTitle: event.issue.title,
      request: body.replace(/@devin\b/gi, "").trim(),
      isPR: false,
      conversationHistory: "",
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", sessions: Object.keys(loadSessionMap()).length });
});

app.listen(PORT, () => {
  console.log(`[devin] Webhook server running on port ${PORT}`);
  console.log(`[devin] Workdir: ${WORKDIR}`);
  console.log(`[devin] Webhook URL: http://localhost:${PORT}/webhook`);
});
