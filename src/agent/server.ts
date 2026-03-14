/**
 * Devin Agent Server
 *
 * Webhook server that receives GitHub @devin mentions, uses LLM to analyze
 * requirements, generate code, and create PRs. Each Issue maps to a conversation
 * context for multi-turn interactions.
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
// Context persistence: Issue → conversation history
// ---------------------------------------------------------------------------

type Message = { role: "system" | "user" | "assistant"; content: string };

function contextPath(owner: string, repo: string, issueNumber: number): string {
  return path.join(CONTEXT_DIR, `${owner}_${repo}_${issueNumber}.json`);
}

function loadContext(owner: string, repo: string, issueNumber: number): Message[] {
  try {
    return JSON.parse(fs.readFileSync(contextPath(owner, repo, issueNumber), "utf-8"));
  } catch {
    return [];
  }
}

function saveContext(owner: string, repo: string, issueNumber: number, messages: Message[]) {
  fs.mkdirSync(CONTEXT_DIR, { recursive: true });
  fs.writeFileSync(contextPath(owner, repo, issueNumber), JSON.stringify(messages, null, 2));
}

// ---------------------------------------------------------------------------
// GitHub Helpers (via gh CLI)
// ---------------------------------------------------------------------------

function verifySignature(payload: string, signature: string): boolean {
  if (!WEBHOOK_SECRET) return true;
  const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function ghComment(owner: string, repo: string, issueNumber: number, body: string) {
  try {
    const escaped = body.replace(/'/g, "'\\''");
    execSync(`gh issue comment ${issueNumber} --repo ${owner}/${repo} --body '${escaped}'`, {
      stdio: "pipe",
      timeout: 30000,
    });
  } catch (e) {
    console.error(`[devin] Failed to comment:`, e instanceof Error ? e.message : e);
  }
}

function ghGetIssueBody(owner: string, repo: string, issueNumber: number): string {
  try {
    return execSync(
      `gh issue view ${issueNumber} --repo ${owner}/${repo} --json body --jq .body`,
      { stdio: "pipe", timeout: 15000 },
    ).toString().trim();
  } catch {
    return "";
  }
}

function ghCreateFile(owner: string, repo: string, filePath: string, content: string, branch: string, message: string) {
  const encoded = Buffer.from(content).toString("base64");
  // Check if file exists on branch
  try {
    const sha = execSync(
      `gh api repos/${owner}/${repo}/contents/${filePath}?ref=${branch} --jq .sha 2>/dev/null`,
      { stdio: "pipe", timeout: 10000 },
    ).toString().trim();
    // File exists, update it
    execSync(
      `gh api repos/${owner}/${repo}/contents/${filePath} --method PUT -f message="${message}" -f content="${encoded}" -f branch="${branch}" -f sha="${sha}"`,
      { stdio: "pipe", timeout: 30000 },
    );
  } catch {
    // File doesn't exist, create it
    execSync(
      `gh api repos/${owner}/${repo}/contents/${filePath} --method PUT -f message="${message}" -f content="${encoded}" -f branch="${branch}"`,
      { stdio: "pipe", timeout: 30000 },
    );
  }
}

// ---------------------------------------------------------------------------
// LLM helpers
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

// ---------------------------------------------------------------------------
// Core: Handle @devin mention
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
  ghComment(owner, repo, issueNumber, "🤖 收到！正在分析需求...");

  try {
    // Load conversation context for this issue
    let messages = loadContext(owner, repo, issueNumber);

    // First interaction: set up system prompt and gather context
    if (messages.length === 0) {
      // Get repo file tree
      let fileTree = "";
      try {
        fileTree = execSync(
          `gh api repos/${owner}/${repo}/git/trees/main?recursive=1 --jq '.tree[] | select(.type=="blob") | .path' 2>/dev/null | head -100`,
          { stdio: "pipe", timeout: 15000 },
        ).toString().trim();
      } catch { /* empty repo */ }

      // Get README or CLAUDE.md
      let projectContext = "";
      try {
        projectContext = execSync(
          `gh api repos/${owner}/${repo}/contents/README.md --jq .content 2>/dev/null | base64 -d`,
          { stdio: "pipe", timeout: 10000 },
        ).toString().trim();
      } catch { /* no readme */ }

      const issueBody = ghGetIssueBody(owner, repo, issueNumber);

      messages = [{
        role: "system",
        content: `你是 Devin，一个 AI 软件工程师。你通过 GitHub Issue 接收需求并自动完成开发工作。

当前项目：${owner}/${repo}
Issue #${issueNumber}：${issueTitle}

项目文件结构：
${fileTree || "(空项目)"}

${projectContext ? `项目说明：\n${projectContext}` : ""}

你的工作方式：
1. 分析需求。如果不清晰，输出需要澄清的问题列表，格式：{"action": "clarify", "questions": ["问题1", "问题2"]}
2. 如果需求明确，制定方案并生成代码。输出格式：
{
  "action": "implement",
  "summary": "方案摘要",
  "files": [
    {"path": "文件路径", "content": "完整文件内容"}
  ],
  "branch": "devin/issue-${issueNumber}-简短描述",
  "pr_title": "PR 标题"
}

关键规则：
- 只输出 JSON，不要输出其他内容
- 文件内容必须是完整的，可以直接使用的代码
- branch 名使用英文小写和连字符
- 代码质量要高，界面要好看`,
      }, {
        role: "user",
        content: `Issue 标题：${issueTitle}\nIssue 内容：${issueBody}\n\n用户请求：${request}`,
      }];
    } else {
      // Follow-up interaction: add the new message
      messages.push({
        role: "user",
        content: `用户追加说：${request}`,
      });
    }

    // Call LLM
    const response = await chat(messages);
    messages.push({ role: "assistant", content: response });
    saveContext(owner, repo, issueNumber, messages);

    // Parse response
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, response];
    let cleaned = (jsonMatch[1] ?? response).trim();
    // Try to extract JSON if there's surrounding text
    const braceMatch = cleaned.match(/\{[\s\S]*\}/);
    if (braceMatch) cleaned = braceMatch[0];

    const result = JSON.parse(cleaned);

    if (result.action === "clarify") {
      const questions = (result.questions as string[]).map((q, i) => `${i + 1}. ${q}`).join("\n");
      ghComment(owner, repo, issueNumber,
        `我需要更多信息来开始工作：\n\n${questions}\n\n请回复后 @devin 我会继续。`
      );
      console.log(`[devin] Clarifying: ${key}`);
      return;
    }

    if (result.action === "implement") {
      // 1. Post plan
      ghComment(owner, repo, issueNumber,
        `## 📋 实施方案\n\n${result.summary}\n\n### 变更文件\n${result.files.map((f: any) => `- \`${f.path}\``).join("\n")}\n\n正在编写代码...`
      );

      // 2. Create branch
      const branchName: string = result.branch || `devin/issue-${issueNumber}`;
      try {
        const mainSha = execSync(
          `gh api repos/${owner}/${repo}/git/ref/heads/main --jq .object.sha`,
          { stdio: "pipe", timeout: 10000 },
        ).toString().trim();
        execSync(
          `gh api repos/${owner}/${repo}/git/refs --method POST -f ref="refs/heads/${branchName}" -f sha="${mainSha}"`,
          { stdio: "pipe", timeout: 10000 },
        );
      } catch (e) {
        console.log(`[devin] Branch may already exist:`, e instanceof Error ? e.message : e);
      }

      // 3. Commit files
      for (const file of result.files) {
        try {
          ghCreateFile(owner, repo, file.path, file.content, branchName, `Add ${file.path}\n\nPart of #${issueNumber}`);
          console.log(`[devin] Committed: ${file.path}`);
        } catch (e) {
          console.error(`[devin] Failed to commit ${file.path}:`, e instanceof Error ? e.message : e);
        }
      }

      // 4. Create PR
      try {
        const prTitle = result.pr_title || `[Devin] ${issueTitle}`;
        const prUrl = execSync(
          `gh pr create --repo ${owner}/${repo} --head ${branchName} --base main --title "${prTitle.replace(/"/g, '\\"')}" --body "## 方案摘要\n\n${result.summary}\n\n## 变更文件\n\n${result.files.map((f: any) => "- \\`" + f.path + "\\`").join("\\n")}\n\n---\nCloses #${issueNumber}\n\n> 🤖 Generated by Devin"`,
          { stdio: "pipe", timeout: 30000 },
        ).toString().trim();

        ghComment(owner, repo, issueNumber,
          `## ✅ PR 已创建\n\n${prUrl}\n\n如果需要修改，请在 Issue 里 @devin 告诉我。`
        );
        console.log(`[devin] PR created: ${prUrl}`);
      } catch (e) {
        console.error(`[devin] Failed to create PR:`, e instanceof Error ? e.message : e);
        ghComment(owner, repo, issueNumber,
          `代码已推送到 \`${branchName}\` 分支，但 PR 创建失败。请手动创建 PR。`
        );
      }
    }

    console.log(`[devin] Completed: ${key}`);
  } catch (error) {
    console.error(`[devin] Error processing ${key}:`, error);
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
    if (event.comment?.user?.login?.includes("[bot]")) return;
    if (event.comment?.user?.login === "github-actions") return;

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
  const contexts = fs.existsSync(CONTEXT_DIR)
    ? fs.readdirSync(CONTEXT_DIR).length
    : 0;
  res.json({ status: "ok", activeContexts: contexts, model: LLM_MODEL });
});

app.listen(PORT, () => {
  console.log(`[devin] Server running on port ${PORT}`);
  console.log(`[devin] Model: ${LLM_MODEL} @ ${LLM_BASE_URL}`);
  console.log(`[devin] Workdir: ${WORKDIR}`);
});
