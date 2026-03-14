import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import {
  getInstallationOctokit,
  postIssueComment,
  createPullRequest,
} from "@/lib/github";
import type { Octokit } from "octokit";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlanFile {
  path: string;
  action: "create" | "modify";
  description: string;
}

interface Plan {
  summary: string;
  files: PlanFile[];
  risks: string[];
}

interface FileChange {
  path: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL = "claude-sonnet-4-20250514";
const anthropic = new Anthropic();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function updateTaskStatus(
  taskId: string,
  status: string,
  extra?: Record<string, unknown>
) {
  await prisma.task.update({
    where: { id: taskId },
    data: { status: status as any, ...extra },
  });
}

async function addTaskLog(
  taskId: string,
  phase: string,
  message: string,
  metadata?: Record<string, unknown>
) {
  await prisma.taskLog.create({
    data: { taskId, phase, message, metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : undefined },
  });
}

async function failTask(taskId: string, phase: string, error: unknown) {
  const errorMessage =
    error instanceof Error ? error.message : String(error);
  await prisma.task.update({
    where: { id: taskId },
    data: { status: "failed", errorMessage },
  });
  await addTaskLog(taskId, phase, `Failed: ${errorMessage}`);
}

function trackTokens(usage: Anthropic.Usage): number {
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

async function accumulateTokens(taskId: string, tokens: number) {
  await prisma.task.update({
    where: { id: taskId },
    data: { tokenUsage: { increment: tokens } },
  });
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

/** List the file tree under a given path (recursive, single level deep via recursion). */
async function getFileTree(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string = "src"
): Promise<string[]> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
    });

    if (!Array.isArray(data)) return [path];

    const paths: string[] = [];
    for (const item of data) {
      if (item.type === "dir") {
        const children = await getFileTree(octokit, owner, repo, item.path);
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

/** Read a single file's contents from the repo (UTF-8). Returns null if not found. */
async function readRepoFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string
): Promise<{ content: string; sha: string } | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
    });

    if (Array.isArray(data) || data.type !== "file") return null;

    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return { content, sha: data.sha };
  } catch {
    return null;
  }
}

/** Create or update a file on a given branch. */
async function writeRepoFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  params: {
    path: string;
    content: string;
    message: string;
    branch: string;
    sha?: string;
  }
) {
  await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: params.path,
    message: params.message,
    content: Buffer.from(params.content).toString("base64"),
    branch: params.branch,
    ...(params.sha ? { sha: params.sha } : {}),
  });
}

/** Get the default branch name for a repo. */
async function getDefaultBranch(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<string> {
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return data.default_branch;
}

/** Create a new branch from the default branch HEAD. */
async function createBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchName: string,
  baseBranch: string
) {
  const { data: ref } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`,
  });

  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: ref.object.sha,
  });
}

// ---------------------------------------------------------------------------
// Phase 1: Planning
// ---------------------------------------------------------------------------

async function planPhase(
  taskId: string,
  task: {
    issueTitle: string;
    issueBody: string;
    repoOwner: string;
    repoName: string;
    issueNumber: number;
  },
  octokit: Octokit
): Promise<Plan> {
  await updateTaskStatus(taskId, "planning");
  await addTaskLog(taskId, "planning", "Starting planning phase");

  // Gather context
  const fileTree = await getFileTree(octokit, task.repoOwner, task.repoName);
  const claudeMd = await readRepoFile(
    octokit,
    task.repoOwner,
    task.repoName,
    "CLAUDE.md"
  );
  const readmeMd =
    claudeMd ??
    (await readRepoFile(octokit, task.repoOwner, task.repoName, "README.md"));

  const projectContext = readmeMd?.content ?? "(no project context file found)";

  const prompt = `你是一个高级软件工程师。根据以下需求和项目上下文，制定实施方案。

需求：${task.issueTitle} - ${task.issueBody}
项目上下文：${projectContext}
文件结构：
${fileTree.join("\n")}

请输出 JSON 格式：
{
  "summary": "方案摘要",
  "files": [
    { "path": "文件路径", "action": "create|modify", "description": "变更说明" }
  ],
  "risks": ["风险点"]
}

只输出 JSON，不要输出其他内容。`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const tokens = trackTokens(response.usage);
  await accumulateTokens(taskId, tokens);

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  // Extract JSON from possible markdown code blocks
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
  const plan: Plan = JSON.parse(jsonMatch[1]!.trim());

  // Persist
  await updateTaskStatus(taskId, "planning", { planSummary: plan.summary });
  await addTaskLog(taskId, "planning", "Plan generated", {
    files: plan.files,
    risks: plan.risks,
  });

  // Comment on Issue
  const commentBody = `## 🤖 Devin 实施方案

${plan.summary}

### 变更文件
${plan.files.map((f) => `- \`${f.path}\` (${f.action}): ${f.description}`).join("\n")}

### 风险评估
${plan.risks.length > 0 ? plan.risks.map((r) => `- ${r}`).join("\n") : "无明显风险"}
`;

  await postIssueComment(
    octokit,
    task.repoOwner,
    task.repoName,
    task.issueNumber,
    commentBody
  );

  return plan;
}

// ---------------------------------------------------------------------------
// Phase 2: Implementing
// ---------------------------------------------------------------------------

async function implementPhase(
  taskId: string,
  task: {
    issueTitle: string;
    issueBody: string;
    repoOwner: string;
    repoName: string;
    issueNumber: number;
    planSummary: string;
  },
  octokit: Octokit,
  plan: Plan
): Promise<{ branchName: string; changes: FileChange[] }> {
  await updateTaskStatus(taskId, "implementing");
  await addTaskLog(taskId, "implementing", "Starting implementation phase");

  const defaultBranch = await getDefaultBranch(
    octokit,
    task.repoOwner,
    task.repoName
  );

  // Create branch
  const slug = task.issueTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 30)
    .replace(/-$/, "");
  const branchName = `devin/issue-${task.issueNumber}-${slug}`;

  await createBranch(
    octokit,
    task.repoOwner,
    task.repoName,
    branchName,
    defaultBranch
  );
  await updateTaskStatus(taskId, "implementing", { branchName });

  const changes: FileChange[] = [];

  for (const file of plan.files) {
    await addTaskLog(
      taskId,
      "implementing",
      `Generating code for ${file.path}`
    );

    // Read current content if modifying
    let currentContent: string | null = null;
    let currentSha: string | undefined;
    if (file.action === "modify") {
      const existing = await readRepoFile(
        octokit,
        task.repoOwner,
        task.repoName,
        file.path
      );
      if (existing) {
        currentContent = existing.content;
        currentSha = existing.sha;
      }
    }

    const codePrompt = `根据以下方案，生成 ${file.path} 的完整代码。

方案：${task.planSummary}
${currentContent ? `当前文件内容：\n${currentContent}` : "这是一个新文件。"}
需求：${task.issueBody}
变更说明：${file.description}

直接输出代码，不要解释。不要用 markdown 代码块包裹。`;

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      messages: [{ role: "user", content: codePrompt }],
    });

    const tokens = trackTokens(response.usage);
    await accumulateTokens(taskId, tokens);

    let code =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Strip markdown code fences if Claude wrapped the output anyway
    const codeBlockMatch = code.match(
      /^```(?:\w+)?\s*\n([\s\S]*?)\n```\s*$/
    );
    if (codeBlockMatch) {
      code = codeBlockMatch[1]!;
    }

    changes.push({ path: file.path, content: code });

    // Commit to branch
    await writeRepoFile(octokit, task.repoOwner, task.repoName, {
      path: file.path,
      content: code,
      message: `${file.action === "create" ? "Add" : "Update"} ${file.path}\n\nPart of #${task.issueNumber}`,
      branch: branchName,
      sha: currentSha,
    });

    await addTaskLog(taskId, "implementing", `Committed ${file.path}`);
  }

  return { branchName, changes };
}

// ---------------------------------------------------------------------------
// Phase 3: Testing (simplified for MVP)
// ---------------------------------------------------------------------------

async function testPhase(
  taskId: string,
  task: {
    repoOwner: string;
    repoName: string;
    issueNumber: number;
  },
  octokit: Octokit,
  changes: FileChange[]
): Promise<void> {
  await updateTaskStatus(taskId, "testing");
  await addTaskLog(taskId, "testing", "Starting testing phase (MVP: syntax check)");

  const issues: string[] = [];

  for (const change of changes) {
    // Basic syntax checks
    if (
      change.path.endsWith(".ts") ||
      change.path.endsWith(".tsx") ||
      change.path.endsWith(".js") ||
      change.path.endsWith(".jsx")
    ) {
      // Check for obviously broken syntax patterns
      const openBraces = (change.content.match(/{/g) ?? []).length;
      const closeBraces = (change.content.match(/}/g) ?? []).length;
      if (openBraces !== closeBraces) {
        issues.push(
          `${change.path}: mismatched braces (open: ${openBraces}, close: ${closeBraces})`
        );
      }

      const openParens = (change.content.match(/\(/g) ?? []).length;
      const closeParens = (change.content.match(/\)/g) ?? []).length;
      if (openParens !== closeParens) {
        issues.push(
          `${change.path}: mismatched parentheses (open: ${openParens}, close: ${closeParens})`
        );
      }
    }
  }

  const testResult =
    issues.length === 0
      ? "All basic syntax checks passed."
      : `Found potential issues:\n${issues.map((i) => `- ${i}`).join("\n")}`;

  await addTaskLog(taskId, "testing", testResult);

  await postIssueComment(
    octokit,
    task.repoOwner,
    task.repoName,
    task.issueNumber,
    `## 🧪 测试结果\n\n${testResult}`
  );
}

// ---------------------------------------------------------------------------
// Phase 4: PR Creation
// ---------------------------------------------------------------------------

async function prPhase(
  taskId: string,
  task: {
    issueTitle: string;
    repoOwner: string;
    repoName: string;
    issueNumber: number;
    planSummary: string;
  },
  octokit: Octokit,
  branchName: string,
  changes: FileChange[]
): Promise<void> {
  const defaultBranch = await getDefaultBranch(
    octokit,
    task.repoOwner,
    task.repoName
  );

  const prBody = `## 方案摘要

${task.planSummary}

## 变更文件

${changes.map((c) => `- \`${c.path}\``).join("\n")}

---

Closes #${task.issueNumber}

> 🤖 This PR was generated automatically by Devin.`;

  const pr = await createPullRequest(
    octokit,
    task.repoOwner,
    task.repoName,
    {
      title: `[Devin] ${task.issueTitle}`,
      head: branchName,
      base: defaultBranch,
      body: prBody,
    }
  );

  await updateTaskStatus(taskId, "pr_created", {
    prNumber: pr.number,
    prUrl: pr.html_url,
  });
  await addTaskLog(taskId, "pr_created", `PR created: ${pr.html_url}`);

  await postIssueComment(
    octokit,
    task.repoOwner,
    task.repoName,
    task.issueNumber,
    `## 🔗 PR 已创建\n\n[#${pr.number} - ${task.issueTitle}](${pr.html_url})`
  );
}

// ---------------------------------------------------------------------------
// Phase 5: Revising (handle review comments)
// ---------------------------------------------------------------------------

export async function revisePhase(
  taskId: string,
  task: {
    issueBody: string;
    repoOwner: string;
    repoName: string;
    issueNumber: number;
    prNumber: number;
    branchName: string;
    planSummary: string;
  },
  octokit: Octokit
): Promise<void> {
  await updateTaskStatus(taskId, "revising");
  await addTaskLog(taskId, "revising", "Processing review comments");

  // Fetch PR review comments
  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner: task.repoOwner,
    repo: task.repoName,
    pull_number: task.prNumber,
  });

  const { data: reviewComments } =
    await octokit.rest.pulls.listReviewComments({
      owner: task.repoOwner,
      repo: task.repoName,
      pull_number: task.prNumber,
    });

  if (reviewComments.length === 0 && reviews.length === 0) {
    await addTaskLog(taskId, "revising", "No review comments found");
    await updateTaskStatus(taskId, "pr_created");
    return;
  }

  // Collect all review feedback
  const feedback = [
    ...reviews
      .filter((r) => r.body && r.body.trim().length > 0)
      .map((r) => `Review (${r.state}): ${r.body}`),
    ...reviewComments.map(
      (c) =>
        `Comment on \`${c.path}\` line ${c.line ?? c.original_line ?? "?"}: ${c.body}`
    ),
  ].join("\n\n");

  // Ask Claude how to address the feedback
  const revisionPrompt = `你是一个高级软件工程师。以下是代码审查的反馈意见，请根据反馈生成修改。

原始方案：${task.planSummary}
需求：${task.issueBody}

审查反馈：
${feedback}

请输出 JSON 格式：
{
  "changes": [
    { "path": "文件路径", "description": "修改说明" }
  ],
  "response": "对审查者的回复说明"
}

只输出 JSON，不要输出其他内容。`;

  const planResponse = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{ role: "user", content: revisionPrompt }],
  });

  let tokens = trackTokens(planResponse.usage);
  await accumulateTokens(taskId, tokens);

  const planText =
    planResponse.content[0].type === "text"
      ? planResponse.content[0].text
      : "";
  const jsonMatch =
    planText.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, planText];
  const revisionPlan = JSON.parse(jsonMatch[1]!.trim()) as {
    changes: { path: string; description: string }[];
    response: string;
  };

  // Generate and commit each file change
  for (const change of revisionPlan.changes) {
    const existing = await readRepoFile(
      octokit,
      task.repoOwner,
      task.repoName,
      change.path
    );

    const codePrompt = `根据审查反馈修改 ${change.path}。

修改说明：${change.description}
审查反馈：${feedback}
${existing ? `当前文件内容：\n${existing.content}` : "文件不存在，需要新建。"}

直接输出完整的文件代码，不要解释。不要用 markdown 代码块包裹。`;

    const codeResponse = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      messages: [{ role: "user", content: codePrompt }],
    });

    tokens = trackTokens(codeResponse.usage);
    await accumulateTokens(taskId, tokens);

    let code =
      codeResponse.content[0].type === "text"
        ? codeResponse.content[0].text
        : "";
    const codeBlockMatch = code.match(
      /^```(?:\w+)?\s*\n([\s\S]*?)\n```\s*$/
    );
    if (codeBlockMatch) {
      code = codeBlockMatch[1]!;
    }

    // Read the file on the branch to get the correct sha
    const branchFile = await readRepoFileOnBranch(
      octokit,
      task.repoOwner,
      task.repoName,
      change.path,
      task.branchName
    );

    await writeRepoFile(octokit, task.repoOwner, task.repoName, {
      path: change.path,
      content: code,
      message: `Address review: ${change.description}\n\nPart of #${task.issueNumber}`,
      branch: task.branchName,
      sha: branchFile?.sha,
    });

    await addTaskLog(
      taskId,
      "revising",
      `Updated ${change.path}: ${change.description}`
    );
  }

  // Comment on PR with revision summary
  await postIssueComment(
    octokit,
    task.repoOwner,
    task.repoName,
    task.prNumber,
    `## 🔄 Review 修改完成\n\n${revisionPlan.response}\n\n### 变更\n${revisionPlan.changes.map((c) => `- \`${c.path}\`: ${c.description}`).join("\n")}`
  );

  await updateTaskStatus(taskId, "pr_created");
  await addTaskLog(taskId, "revising", "Revision complete");
}

/** Read a file on a specific branch. */
async function readRepoFileOnBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  branch: string
): Promise<{ content: string; sha: string } | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref: branch,
    });

    if (Array.isArray(data) || data.type !== "file") return null;

    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return { content, sha: data.sha };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function executeTask(taskId: string): Promise<void> {
  const task = await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    include: { installation: true },
  });

  const octokit = await getInstallationOctokit(task.installation.githubId);

  try {
    // Phase 1: Planning
    const plan = await planPhase(
      taskId,
      {
        issueTitle: task.issueTitle,
        issueBody: task.issueBody,
        repoOwner: task.repoOwner,
        repoName: task.repoName,
        issueNumber: task.issueNumber,
      },
      octokit
    );

    // Phase 2: Implementing
    const { branchName, changes } = await implementPhase(
      taskId,
      {
        issueTitle: task.issueTitle,
        issueBody: task.issueBody,
        repoOwner: task.repoOwner,
        repoName: task.repoName,
        issueNumber: task.issueNumber,
        planSummary: plan.summary,
      },
      octokit,
      plan
    );

    // Phase 3: Testing
    await testPhase(
      taskId,
      {
        repoOwner: task.repoOwner,
        repoName: task.repoName,
        issueNumber: task.issueNumber,
      },
      octokit,
      changes
    );

    // Phase 4: PR Creation
    await prPhase(
      taskId,
      {
        issueTitle: task.issueTitle,
        repoOwner: task.repoOwner,
        repoName: task.repoName,
        issueNumber: task.issueNumber,
        planSummary: plan.summary,
      },
      octokit,
      branchName,
      changes
    );

    await addTaskLog(taskId, "pr_created", "Task completed successfully");
  } catch (error) {
    await failTask(taskId, "execution", error);
    throw error;
  }
}
