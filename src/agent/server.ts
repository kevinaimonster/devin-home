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

function ghCreateFile(owner: string, repo: string, filePath: string, content: string, branch: string, message: string) {
  const encoded = Buffer.from(content).toString("base64");
  const sha = ghSafe(`gh api repos/${owner}/${repo}/contents/${filePath}?ref=${branch} --jq .sha`);
  const shaFlag = sha ? `-f sha="${sha}"` : "";
  gh(`gh api repos/${owner}/${repo}/contents/${filePath} --method PUT -f message="${message.replace(/"/g, '\\"')}" -f content="${encoded}" -f branch="${branch}" ${shaFlag}`);
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
  // Try to extract JSON from potential markdown wrapping
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  let cleaned = jsonMatch ? jsonMatch[1]!.trim() : text.trim();
  const braceMatch = cleaned.match(/\{[\s\S]*\}/);
  if (braceMatch) cleaned = braceMatch[0];
  return JSON.parse(cleaned);
}

// ---------------------------------------------------------------------------
// Actions: each action Devin can take
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
      ghCreateFile(owner, repo, action.path, action.content, action.branch, action.message || `Update ${action.path}`);
      return `Committed ${action.path} to ${action.branch}.`;
    }

    case "create_pr": {
      const tmpFile = path.join(WORKDIR, `.pr-body-${Date.now()}.md`);
      fs.writeFileSync(tmpFile, action.body || "");
      const url = gh(`gh pr create --repo ${owner}/${repo} --head ${action.branch} --base main --title "${(action.title || "").replace(/"/g, '\\"')}" --body-file ${tmpFile}`);
      fs.unlinkSync(tmpFile);
      return `PR created: ${url}`;
    }

    case "review_pr": {
      // Self-review: read the PR diff and provide review
      const diff = ghSafe(`gh pr diff ${action.pr_number} --repo ${owner}/${repo}`);
      return `PR #${action.pr_number} diff:\n${diff.slice(0, 3000)}`;
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
      // Enable GitHub Pages on the repo (serves from main branch root or /docs)
      ghSafe(`gh api repos/${owner}/${repo}/pages --method POST -f source='{"branch":"main","path":"/"}' 2>/dev/null`);
      const pagesUrl = ghSafe(`gh api repos/${owner}/${repo}/pages --jq .html_url`);
      return pagesUrl ? `GitHub Pages deployed: ${pagesUrl}` : "GitHub Pages deployment initiated (may take a minute).";
    }

    case "read_file": {
      const content = ghSafe(`gh api repos/${owner}/${repo}/contents/${action.path}?ref=${action.ref || "main"} --jq .content | base64 -d`);
      return content ? `Content of ${action.path}:\n${content.slice(0, 3000)}` : `File ${action.path} not found.`;
    }

    case "list_files": {
      const tree = ghSafe(`gh api repos/${owner}/${repo}/git/trees/${action.ref || "main"}?recursive=1 --jq '.tree[] | select(.type=="blob") | .path' | head -100`);
      return `Files:\n${tree}`;
    }

    default:
      return `Unknown action: ${action.action}`;
  }
}

// ---------------------------------------------------------------------------
// Core: autonomous agent loop
// ---------------------------------------------------------------------------

async function handleDevinMention(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  request: string;
  isPR: boolean;
}) {
  const { owner, repo, issueNumber, issueTitle, request, isPR } = params;
  const key = `${owner}/${repo}#${issueNumber}`;
  console.log(`[devin] Processing: ${key}`);

  try {
    let messages = loadContext(owner, repo, issueNumber);

    if (messages.length === 0) {
      let fileTree = ghSafe(`gh api repos/${owner}/${repo}/git/trees/main?recursive=1 --jq '.tree[] | select(.type=="blob") | .path' | head -100`);
      let projectContext = ghSafe(`gh api repos/${owner}/${repo}/contents/README.md --jq .content | base64 -d`);
      const issueBody = ghSafe(`gh issue view ${issueNumber} --repo ${owner}/${repo} --json body --jq .body`);

      messages = [{
        role: "system",
        content: `你是 Devin，一个自主工作的 AI 软件工程师。你可以独立完成从需求分析到部署的完整工作流。

当前项目：${owner}/${repo}
Issue #${issueNumber}：${issueTitle}

文件结构：
${fileTree || "(空项目)"}
${projectContext ? `\n项目说明：\n${projectContext}` : ""}

## 你可以执行的动作

你每次回复一个 JSON 对象，包含 "actions" 数组和 "done" 标志。系统会依次执行每个 action 并把结果反馈给你，你可以根据结果决定下一步。

可用 actions：
- {"action": "comment", "body": "评论内容"} — 在 Issue 上发评论
- {"action": "create_branch", "branch": "分支名"} — 创建新分支
- {"action": "commit_file", "branch": "分支名", "path": "文件路径", "content": "完整文件内容", "message": "commit 信息"} — 提交文件
- {"action": "create_pr", "branch": "分支名", "title": "PR标题", "body": "PR描述"} — 创建 PR
- {"action": "review_pr", "pr_number": N} — 读取 PR diff 进行自我审查
- {"action": "merge_pr", "pr_number": N} — 合并 PR（squash merge + 删除分支）
- {"action": "close_issue"} — 关闭 Issue
- {"action": "deploy_pages"} — 启用 GitHub Pages 部署（适合静态网页项目）
- {"action": "read_file", "path": "文件路径", "ref": "分支名"} — 读取仓库中的文件
- {"action": "list_files", "ref": "分支名"} — 列出仓库文件

## 输出格式

{"actions": [...], "thinking": "你的思考过程", "done": false}

当 done=true 时，agent 循环结束。

## 工作流程（你自主决定）

典型流程：
1. 分析需求，如果不清晰就 comment 提问然后 done=true 等用户回复
2. create_branch → 多个 commit_file → create_pr
3. review_pr 自我审查代码质量
4. 如果审查通过：merge_pr → close_issue
5. 如果项目是静态网页：deploy_pages
6. 最后 comment 汇报结果

你可以根据实际情况调整流程。比如简单的任务可以直接 merge，复杂的可以先不 merge 等人类确认。

## 关键规则
- 只输出 JSON
- branch 命名：devin/issue-${issueNumber}-简短英文描述
- 代码质量要高
- 每个 commit_file 的 content 必须是完整可用的文件内容
- review_pr 时认真检查代码，有问题就修复后再 merge`,
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

    // Agent loop: let LLM decide actions iteratively
    const MAX_ITERATIONS = 10;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      console.log(`[devin] ${key} — iteration ${i + 1}`);

      const response = await chat(messages);
      messages.push({ role: "assistant", content: response });
      saveContext(owner, repo, issueNumber, messages);

      let parsed: any;
      try {
        parsed = parseJSON(response);
      } catch {
        console.error(`[devin] Failed to parse LLM response:`, response.slice(0, 200));
        break;
      }

      if (parsed.thinking) {
        console.log(`[devin] Thinking: ${parsed.thinking.slice(0, 100)}`);
      }

      // Execute actions and collect results
      const actions: any[] = parsed.actions ?? [];
      const results: string[] = [];

      for (const action of actions) {
        try {
          console.log(`[devin] Executing: ${action.action}${action.path ? ` ${action.path}` : ""}${action.pr_number ? ` #${action.pr_number}` : ""}`);
          const result = execAction(action, owner, repo, issueNumber);
          results.push(`✓ ${action.action}: ${result}`);
          console.log(`[devin] ✓ ${action.action}`);
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          results.push(`✗ ${action.action} failed: ${errMsg}`);
          console.error(`[devin] ✗ ${action.action}: ${errMsg}`);
        }
      }

      // Check if done
      if (parsed.done === true) {
        console.log(`[devin] ${key} — done`);
        break;
      }

      // Feed results back to LLM for next iteration
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

    console.log(`[devin] Completed: ${key}`);
  } catch (error) {
    console.error(`[devin] Error: ${key}:`, error);
    ghComment(owner, repo, issueNumber,
      `处理时遇到了错误：\n\n\`\`\`\n${error instanceof Error ? error.message : String(error)}\n\`\`\``
    );
  }
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

app.get("/health", (_req, res) => {
  const contexts = fs.existsSync(CONTEXT_DIR) ? fs.readdirSync(CONTEXT_DIR).length : 0;
  res.json({ status: "ok", activeContexts: contexts, model: LLM_MODEL });
});

app.listen(PORT, () => {
  console.log(`[devin] Server running on port ${PORT}`);
  console.log(`[devin] Model: ${LLM_MODEL} @ ${LLM_BASE_URL}`);
  console.log(`[devin] Workdir: ${WORKDIR}`);
});
