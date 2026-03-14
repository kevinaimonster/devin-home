/**
 * Devin Agent — GitHub Actions entry point.
 *
 * Triggered when someone @devin in an issue comment or issue body.
 * Reads the GitHub event, dispatches to the appropriate handler,
 * and interacts via the GitHub API (comment, create PR, etc.).
 */

import fs from "fs";
import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "octokit";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const GITHUB_EVENT_PATH = process.env.GITHUB_EVENT_PATH!;
const GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME!;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY!;

const [REPO_OWNER, REPO_NAME] = GITHUB_REPOSITORY.split("/");

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-4-20250514";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GitHubEvent {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    labels: Array<{ name: string }>;
    pull_request?: unknown;
  };
  comment?: {
    body: string;
    user: { login: string };
    id: number;
  };
}

interface Plan {
  summary: string;
  files: Array<{ path: string; action: "create" | "modify"; description: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function commentOnIssue(issueNumber: number, body: string) {
  await octokit.rest.issues.createComment({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    issue_number: issueNumber,
    body,
  });
}

async function getFileTree(path = "."): Promise<string[]> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path,
    });
    if (!Array.isArray(data)) return [path];

    const paths: string[] = [];
    for (const item of data) {
      if (item.name.startsWith(".") || item.name === "node_modules") continue;
      if (item.type === "dir") {
        const children = await getFileTree(item.path);
        paths.push(...children);
      } else {
        paths.push(item.path);
      }
    }
    return paths;
  } catch {
    return [];
  }
}

async function readFile(path: string): Promise<{ content: string; sha: string } | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path,
    });
    if (Array.isArray(data) || data.type !== "file") return null;
    return {
      content: Buffer.from(data.content, "base64").toString("utf-8"),
      sha: data.sha,
    };
  } catch {
    return null;
  }
}

async function readFileOnBranch(path: string, branch: string): Promise<{ content: string; sha: string } | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path,
      ref: branch,
    });
    if (Array.isArray(data) || data.type !== "file") return null;
    return {
      content: Buffer.from(data.content, "base64").toString("utf-8"),
      sha: data.sha,
    };
  } catch {
    return null;
  }
}

async function getDefaultBranch(): Promise<string> {
  const { data } = await octokit.rest.repos.get({ owner: REPO_OWNER, repo: REPO_NAME });
  return data.default_branch;
}

async function createBranch(branchName: string, baseBranch: string) {
  const { data: ref } = await octokit.rest.git.getRef({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    ref: `heads/${baseBranch}`,
  });
  await octokit.rest.git.createRef({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    ref: `refs/heads/${branchName}`,
    sha: ref.object.sha,
  });
}

async function writeFile(params: {
  path: string;
  content: string;
  message: string;
  branch: string;
  sha?: string;
}) {
  await octokit.rest.repos.createOrUpdateFileContents({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path: params.path,
    message: params.message,
    content: Buffer.from(params.content).toString("base64"),
    branch: params.branch,
    ...(params.sha ? { sha: params.sha } : {}),
  });
}

function extractRequest(text: string): string {
  // Remove @devin mention and extract the actual request
  return text.replace(/@devin\b/gi, "").trim();
}

// ---------------------------------------------------------------------------
// Core: Analyze → Plan → Implement → PR
// ---------------------------------------------------------------------------

async function analyzeAndPlan(
  issueTitle: string,
  request: string,
  issueNumber: number
): Promise<Plan | null> {
  // 1. Collect context
  const fileTree = await getFileTree();
  const claudeMd = await readFile("CLAUDE.md");
  const readme = claudeMd ?? await readFile("README.md");
  const projectContext = readme?.content ?? "(no project context found)";

  // 2. Analyze + Plan
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{
      role: "user",
      content: `你是 Devin，一个 AI 软件工程师。用户通过 GitHub Issue 向你提了一个需求。

Issue 标题：${issueTitle}
用户请求：${request}

项目上下文：
${projectContext}

当前文件结构：
${fileTree.join("\n")}

请分析这个需求并制定实施方案。

如果需求不明确，返回：
{"unclear": true, "questions": ["问题1", "问题2"]}

如果需求明确，返回：
{"unclear": false, "summary": "方案摘要", "files": [{"path": "文件路径", "action": "create 或 modify", "description": "变更说明"}]}

只返回 JSON。`,
    }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const result = JSON.parse(cleaned);

  if (result.unclear) {
    const questions = (result.questions as string[]).map((q, i) => `${i + 1}. ${q}`).join("\n");
    await commentOnIssue(
      issueNumber,
      `我需要更多信息来开始工作：\n\n${questions}\n\n请回复后 @devin 我会继续。`
    );
    return null;
  }

  return result as Plan;
}

async function implement(
  plan: Plan,
  issueTitle: string,
  issueBody: string,
  issueNumber: number
) {
  // 1. Comment plan
  await commentOnIssue(
    issueNumber,
    `## 实施方案\n\n${plan.summary}\n\n### 变更文件\n${plan.files.map(f => `- \`${f.path}\` (${f.action}): ${f.description}`).join("\n")}\n\n开始实现...`
  );

  // 2. Create branch
  const defaultBranch = await getDefaultBranch();
  const slug = issueTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30).replace(/-$/, "");
  const branchName = `devin/issue-${issueNumber}-${slug}`;

  await createBranch(branchName, defaultBranch);

  // 3. Generate and commit each file
  for (const file of plan.files) {
    let currentContent: string | null = null;
    let currentSha: string | undefined;

    if (file.action === "modify") {
      const existing = await readFile(file.path);
      if (existing) {
        currentContent = existing.content;
        currentSha = existing.sha;
      }
    }

    const codeResponse = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      messages: [{
        role: "user",
        content: `根据以下方案，生成 ${file.path} 的完整代码。

方案：${plan.summary}
变更说明：${file.description}
需求：${issueBody}
${currentContent ? `\n当前文件内容：\n${currentContent}` : "这是一个新文件。"}

直接输出代码，不要解释，不要用 markdown 代码块包裹。`,
      }],
    });

    let code = codeResponse.content[0].type === "text" ? codeResponse.content[0].text : "";
    const codeBlockMatch = code.match(/^```(?:\w+)?\s*\n([\s\S]*?)\n```\s*$/);
    if (codeBlockMatch) code = codeBlockMatch[1]!;

    await writeFile({
      path: file.path,
      content: code,
      message: `${file.action === "create" ? "Add" : "Update"} ${file.path}\n\nPart of #${issueNumber}`,
      branch: branchName,
      sha: currentSha,
    });
  }

  // 4. Create PR
  const { data: pr } = await octokit.rest.pulls.create({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    title: `[Devin] ${issueTitle}`,
    head: branchName,
    base: defaultBranch,
    body: `## 方案摘要\n\n${plan.summary}\n\n## 变更文件\n\n${plan.files.map(f => `- \`${f.path}\`: ${f.description}`).join("\n")}\n\n---\nCloses #${issueNumber}\n\n> 🤖 Generated by Devin`,
  });

  // 5. Comment on issue
  await commentOnIssue(
    issueNumber,
    `PR 已创建：[#${pr.number} - ${issueTitle}](${pr.html_url})\n\n如果需要修改，请在 PR 里提 review，@devin 我会自动处理。`
  );
}

async function handleReviewComment(
  issueNumber: number,
  request: string,
  prNumber: number
) {
  // Get PR info
  const { data: pr } = await octokit.rest.pulls.get({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    pull_number: prNumber,
  });

  const branchName = pr.head.ref;

  // Get review comments
  const { data: reviewComments } = await octokit.rest.pulls.listReviewComments({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    pull_number: prNumber,
  });

  const feedback = reviewComments.map(c =>
    `File \`${c.path}\` line ${c.line ?? "?"}: ${c.body}`
  ).join("\n\n");

  const allFeedback = `${request}\n\n${feedback}`;

  // Get changed files
  const { data: files } = await octokit.rest.pulls.listFiles({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    pull_number: prNumber,
  });

  for (const file of files) {
    const existing = await readFileOnBranch(file.filename, branchName);
    if (!existing) continue;

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      messages: [{
        role: "user",
        content: `根据以下审查反馈修改 ${file.filename}。

反馈：${allFeedback}

当前文件内容：
${existing.content}

直接输出完整的修改后代码，不要解释，不要用 markdown 代码块包裹。`,
      }],
    });

    let code = response.content[0].type === "text" ? response.content[0].text : "";
    const codeBlockMatch = code.match(/^```(?:\w+)?\s*\n([\s\S]*?)\n```\s*$/);
    if (codeBlockMatch) code = codeBlockMatch[1]!;

    // Only commit if content actually changed
    if (code.trim() !== existing.content.trim()) {
      await writeFile({
        path: file.filename,
        content: code,
        message: `Address review feedback for ${file.filename}\n\nPart of #${issueNumber}`,
        branch: branchName,
        sha: existing.sha,
      });
    }
  }

  await commentOnIssue(issueNumber, `已根据反馈更新代码，请再次 review。`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const event: GitHubEvent = JSON.parse(fs.readFileSync(GITHUB_EVENT_PATH, "utf-8"));
  const issueNumber = event.issue.number;
  const issueTitle = event.issue.title;
  const isPR = !!event.issue.pull_request;

  console.log(`[devin] Event: ${GITHUB_EVENT_NAME}, Action: ${event.action}, Issue #${issueNumber}`);

  try {
    if (GITHUB_EVENT_NAME === "issue_comment" && event.comment) {
      const request = extractRequest(event.comment.body);

      if (isPR) {
        // Comment on a PR — treat as review feedback
        await handleReviewComment(issueNumber, request, issueNumber);
      } else {
        // Comment on an Issue — analyze and implement
        const plan = await analyzeAndPlan(issueTitle, request, issueNumber);
        if (plan) {
          await implement(plan, issueTitle, request, issueNumber);
        }
      }
    } else if (GITHUB_EVENT_NAME === "issues" && event.action === "opened") {
      // New issue with @devin in body
      const request = extractRequest(event.issue.body ?? "");
      const plan = await analyzeAndPlan(issueTitle, request, issueNumber);
      if (plan) {
        await implement(plan, issueTitle, request, issueNumber);
      }
    }

    console.log("[devin] Done.");
  } catch (error) {
    console.error("[devin] Error:", error);
    await commentOnIssue(
      issueNumber,
      `遇到了一个错误，请检查 Actions 日志：\n\n\`\`\`\n${error instanceof Error ? error.message : String(error)}\n\`\`\``
    );
    process.exit(1);
  }
}

main();
