import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { getInstallationOctokit, postIssueComment } from "@/lib/github";
import { executeTask } from "@/lib/worker";
import type { GitHubWebhookEvent } from "@/types";

const anthropic = new Anthropic();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AnalysisResult {
  type: "feature" | "bugfix" | "refactor" | "unclear";
  questions?: string[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Call Claude to analyze an issue's title + body and return structured JSON.
 */
async function analyzeIssue(
  title: string,
  body: string
): Promise<AnalysisResult> {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `你是一个需求分析助手。分析以下 GitHub Issue，判断：
1. 类型：feature（新功能）、bugfix（修复bug）、refactor（重构）、unclear（需求不明确）
2. 如果是 unclear，列出需要澄清的具体问题
3. 简要总结需求要点

Issue 标题：${title}
Issue 内容：${body}

请以 JSON 格式返回，格式如下：
{
  "type": "feature" | "bugfix" | "refactor" | "unclear",
  "questions": ["问题1", "问题2"],  // 仅当 type 为 unclear 时需要
  "summary": "需求要点总结"
}

只返回 JSON，不要包含其他内容。`,
      },
    ],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "";
  // Strip possible markdown code fences
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(cleaned) as AnalysisResult;
}

/**
 * Re-analyze an issue with extra human context to decide if requirements are
 * now clear enough.
 */
async function reanalyzeWithContext(
  title: string,
  body: string,
  humanReply: string
): Promise<AnalysisResult> {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `你是一个需求分析助手。之前分析的 Issue 需求不够明确，现在用户提供了更多信息。请重新分析。

Issue 标题：${title}
Issue 内容：${body}

用户补充信息：${humanReply}

请判断需求现在是否明确：
1. 类型：feature（新功能）、bugfix（修复bug）、refactor（重构）、unclear（仍然不明确）
2. 如果仍然是 unclear，列出还需要澄清的具体问题
3. 简要总结需求要点

请以 JSON 格式返回：
{
  "type": "feature" | "bugfix" | "refactor" | "unclear",
  "questions": ["问题1", "问题2"],
  "summary": "需求要点总结"
}

只返回 JSON，不要包含其他内容。`,
      },
    ],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "";
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(cleaned) as AnalysisResult;
}

/**
 * Ensure an Installation record exists for the given GitHub App installation
 * and return its database id.
 */
async function ensureInstallation(
  event: GitHubWebhookEvent
): Promise<string> {
  const ghId = event.installation!.id;
  const installation = await prisma.installation.upsert({
    where: { githubId: ghId },
    update: {},
    create: {
      githubId: ghId,
      accountLogin: event.installation!.account.login,
      accountType: event.installation!.account.type,
      repositorySelection: "selected",
    },
  });
  return installation.id;
}

/**
 * Write a TaskLog entry.
 */
async function log(
  taskId: string,
  phase: string,
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await prisma.taskLog.create({
    data: {
      taskId,
      phase,
      message,
      metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : undefined,
    },
  });
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * Handle "issues" event with action "labeled" — a new task request.
 */
async function handleIssueLabeled(
  event: GitHubWebhookEvent
): Promise<void> {
  const issue = event.issue!;
  const repo = event.repository!;
  const installationGhId = event.installation!.id;

  const installationDbId = await ensureInstallation(event);

  // Analyze the issue with Claude
  const analysis = await analyzeIssue(issue.title, issue.body ?? "");

  if (analysis.type === "unclear") {
    // --- Unclear: ask for clarification ---
    const questions = (analysis.questions ?? [])
      .map((q, i) => `${i + 1}. ${q}`)
      .join("\n");

    const commentBody = `Thanks for the issue! I need a bit more information before I can start working on this.\n\n${questions}\n\nPlease reply with the details and I'll get started.`;

    const octokit = await getInstallationOctokit(installationGhId);
    await postIssueComment(
      octokit,
      repo.owner.login,
      repo.name,
      issue.number,
      commentBody
    );

    const task = await prisma.task.create({
      data: {
        status: "clarifying",
        issueType: "unclear",
        installationId: installationDbId,
        repoOwner: repo.owner.login,
        repoName: repo.name,
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueBody: issue.body ?? "",
        issueUrl: issue.html_url,
        planSummary: analysis.summary,
      },
    });

    await log(task.id, "analyzing", "Issue analyzed as unclear, asking for clarification", {
      analysis,
    });
  } else {
    // --- Clear requirement: create task and start worker ---
    const task = await prisma.task.create({
      data: {
        status: "analyzing",
        issueType: analysis.type,
        installationId: installationDbId,
        repoOwner: repo.owner.login,
        repoName: repo.name,
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueBody: issue.body ?? "",
        issueUrl: issue.html_url,
        planSummary: analysis.summary,
      },
    });

    await log(task.id, "analyzing", `Issue analyzed as ${analysis.type}, starting worker`, {
      analysis,
    });

    // Fire-and-forget: let the worker run asynchronously
    executeTask(task.id).catch(async (err: unknown) => {
      await log(task.id, "error", `Worker failed: ${String(err)}`);
      await prisma.task.update({
        where: { id: task.id },
        data: { status: "failed", errorMessage: String(err) },
      });
    });
  }
}

/**
 * Handle "issue_comment" event with action "created" — a human replied.
 */
async function handleIssueComment(
  event: GitHubWebhookEvent
): Promise<void> {
  const issue = event.issue!;
  const repo = event.repository!;
  const comment = event.comment!;
  const installationGhId = event.installation!.id;

  // Ignore bot comments to avoid loops
  if (comment.user.login.endsWith("[bot]")) return;

  // Find the associated task
  const task = await prisma.task.findFirst({
    where: {
      repoOwner: repo.owner.login,
      repoName: repo.name,
      issueNumber: issue.number,
    },
    orderBy: { createdAt: "desc" },
  });

  if (!task) return;

  // ----- Task is in "clarifying" state -----
  if (task.status === "clarifying") {
    const analysis = await reanalyzeWithContext(
      task.issueTitle,
      task.issueBody,
      comment.body
    );

    if (analysis.type === "unclear") {
      // Still unclear — ask more questions
      const questions = (analysis.questions ?? [])
        .map((q, i) => `${i + 1}. ${q}`)
        .join("\n");

      const commentBody = `Thanks for the additional info! I still have a few questions:\n\n${questions}\n\nPlease reply and I'll continue.`;

      const octokit = await getInstallationOctokit(installationGhId);
      await postIssueComment(
        octokit,
        repo.owner.login,
        repo.name,
        issue.number,
        commentBody
      );

      await log(task.id, "clarifying", "Re-analyzed with human reply, still unclear", {
        analysis,
      });
    } else {
      // Now clear — update and start worker
      await prisma.task.update({
        where: { id: task.id },
        data: {
          status: "analyzing",
          issueType: analysis.type,
          planSummary: analysis.summary,
        },
      });

      await log(
        task.id,
        "clarifying",
        `Clarification resolved, type determined as ${analysis.type}`,
        { analysis }
      );

      executeTask(task.id).catch(async (err: unknown) => {
        await log(task.id, "error", `Worker failed: ${String(err)}`);
        await prisma.task.update({
          where: { id: task.id },
          data: { status: "failed", errorMessage: String(err) },
        });
      });
    }
    return;
  }

  // ----- Task is in "choosing" state -----
  if (task.status === "choosing") {
    // Parse which plan the user picked (e.g., "A", "方案 B", "option C")
    const choiceMatch = comment.body.match(/[方案\s]*([A-Ca-c])/i);
    const choice = choiceMatch ? choiceMatch[1].toUpperCase() : null;

    if (!choice) {
      const octokit = await getInstallationOctokit(installationGhId);
      await postIssueComment(
        octokit,
        repo.owner.login,
        repo.name,
        issue.number,
        "I couldn't determine your choice. Please reply with A, B, or C to select a plan."
      );
      await log(task.id, "choosing", "Could not parse plan choice from comment", {
        commentBody: comment.body,
      });
      return;
    }

    await prisma.task.update({
      where: { id: task.id },
      data: {
        status: "implementing",
        planSummary: `User selected plan ${choice}`,
      },
    });

    await log(task.id, "choosing", `User selected plan ${choice}`, {
      choice,
    });

    executeTask(task.id).catch(async (err: unknown) => {
      await log(task.id, "error", `Worker failed: ${String(err)}`);
      await prisma.task.update({
        where: { id: task.id },
        data: { status: "failed", errorMessage: String(err) },
      });
    });
    return;
  }
}

/**
 * Handle "pull_request_review" event — code review feedback.
 */
async function handlePRReview(event: GitHubWebhookEvent): Promise<void> {
  const review = event.review!;
  const pr = event.pull_request!;
  const repo = event.repository!;

  if (review.state !== "changes_requested") return;

  // Find the task by PR number
  const task = await prisma.task.findFirst({
    where: {
      repoOwner: repo.owner.login,
      repoName: repo.name,
      prNumber: pr.number,
    },
  });

  if (!task) return;

  await prisma.task.update({
    where: { id: task.id },
    data: { status: "revising" },
  });

  await log(task.id, "revising", "Received changes_requested review, starting revision", {
    reviewBody: review.body,
  });

  executeTask(task.id).catch(async (err: unknown) => {
    await log(task.id, "error", `Worker failed during revision: ${String(err)}`);
    await prisma.task.update({
      where: { id: task.id },
      data: { status: "failed", errorMessage: String(err) },
    });
  });
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

/**
 * Receive a GitHub webhook event, decide what to do, and act on it.
 */
export async function dispatch(event: GitHubWebhookEvent): Promise<void> {
  // 1. Issue labeled — new task
  if (event.action === "labeled" && event.issue && event.label) {
    // Only react to a specific trigger label (e.g., "devin")
    await handleIssueLabeled(event);
    return;
  }

  // 2. Issue comment created — human reply
  if (event.action === "created" && event.comment && event.issue) {
    await handleIssueComment(event);
    return;
  }

  // 3. PR review submitted — code review
  if (event.action === "submitted" && event.review && event.pull_request) {
    await handlePRReview(event);
    return;
  }

  // Unhandled event — silently ignore
}
