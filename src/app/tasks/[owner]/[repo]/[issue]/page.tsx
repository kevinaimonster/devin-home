import Link from "next/link";
import { notFound } from "next/navigation";
import { relativeTime, getStatusLabel, getStatusClasses } from "@/lib/utils";
import type { TaskStatus } from "@/lib/utils";

export const dynamic = "force-dynamic";

const SERVER_URL =
  process.env.NEXT_PUBLIC_DEVIN_SERVER_URL ?? "http://43.173.120.86:3001";

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface TaskDetail {
  owner: string;
  repo: string;
  issueNumber: number;
  messages: Message[];
  lastUpdated: string;
  status: TaskStatus;
}

async function fetchTask(
  owner: string,
  repo: string,
  issue: string
): Promise<TaskDetail | null> {
  try {
    const res = await fetch(
      `${SERVER_URL}/api/tasks/${owner}/${repo}/${issue}`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function tryParseActions(content: string): { thinking?: string; actions?: any[]; done?: boolean } | null {
  try {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    let cleaned = jsonMatch ? jsonMatch[1]!.trim() : content.trim();
    const braceMatch = cleaned.match(/\{[\s\S]*\}/);
    if (braceMatch) cleaned = braceMatch[0];
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function RoleBadge({ role }: { role: Message["role"] }) {
  const styles: Record<string, string> = {
    system: "bg-gray-700/50 text-gray-400",
    user: "bg-indigo-500/10 text-indigo-400",
    assistant: "bg-emerald-500/10 text-emerald-400",
  };
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${styles[role]}`}
    >
      {role}
    </span>
  );
}

function MessageContent({ message }: { message: Message }) {
  if (message.role === "assistant") {
    const parsed = tryParseActions(message.content);
    if (parsed) {
      return (
        <div className="space-y-3">
          {parsed.thinking && (
            <div className="text-sm text-gray-300 leading-relaxed">
              <span className="text-gray-500 text-xs uppercase tracking-wider block mb-1">
                Thinking
              </span>
              {parsed.thinking}
            </div>
          )}
          {parsed.actions && parsed.actions.length > 0 && (
            <div>
              <span className="text-gray-500 text-xs uppercase tracking-wider block mb-1">
                Actions
              </span>
              <div className="space-y-1">
                {parsed.actions.map((action: any, i: number) => (
                  <div
                    key={i}
                    className="rounded bg-gray-800/80 px-3 py-2 text-xs font-mono text-gray-300 overflow-x-auto"
                  >
                    <span className="text-blue-400 font-semibold">
                      {action.action}
                    </span>
                    {action.path && (
                      <span className="text-gray-500 ml-2">{action.path}</span>
                    )}
                    {action.branch && (
                      <span className="text-gray-500 ml-2">
                        branch: {action.branch}
                      </span>
                    )}
                    {action.title && (
                      <span className="text-gray-500 ml-2">
                        &quot;{action.title}&quot;
                      </span>
                    )}
                    {action.pr_number && (
                      <span className="text-gray-500 ml-2">
                        #{action.pr_number}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {parsed.done !== undefined && (
            <div className="text-xs">
              <span
                className={
                  parsed.done ? "text-green-400" : "text-yellow-400"
                }
              >
                {parsed.done ? "Done" : "Continuing..."}
              </span>
            </div>
          )}
        </div>
      );
    }
  }

  // For user and system messages, or unparseable assistant messages
  return (
    <pre className="text-sm text-gray-300 whitespace-pre-wrap break-words font-sans leading-relaxed">
      {message.content.length > 3000
        ? message.content.slice(0, 3000) + "\n... (truncated)"
        : message.content}
    </pre>
  );
}

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string; issue: string }>;
}) {
  const { owner, repo, issue } = await params;
  const task = await fetchTask(owner, repo, issue);

  if (!task) {
    notFound();
  }

  return (
    <div className="space-y-8">
      {/* Back link */}
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white transition-colors"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18"
          />
        </svg>
        Back to tasks
      </Link>

      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${getStatusClasses(task.status)}`}
          >
            {getStatusLabel(task.status)}
          </span>
          <span className="text-sm text-gray-400">
            {task.messages.length} messages
          </span>
          {task.lastUpdated && (
            <span className="text-sm text-gray-500">
              Updated {relativeTime(task.lastUpdated)}
            </span>
          )}
        </div>
        <h1 className="text-2xl font-semibold text-white">
          {owner}/{repo} #{issue}
        </h1>
      </div>

      {/* GitHub link */}
      <div className="flex flex-wrap gap-3">
        <a
          href={`https://github.com/${owner}/${repo}/issues/${issue}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900/50 px-4 py-2 text-sm text-gray-300 hover:text-white hover:border-gray-600 transition-colors"
        >
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 16 16">
            <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
          </svg>
          View Issue on GitHub
        </a>
      </div>

      {/* Conversation Timeline */}
      <div>
        <h2 className="mb-4 text-sm font-medium text-gray-400 uppercase tracking-wider">
          Conversation Timeline
        </h2>
        <div className="space-y-3">
          {task.messages.map((msg, i) => {
            const isSystem = msg.role === "system";
            return (
              <details
                key={i}
                open={!isSystem}
                className="rounded-lg border border-gray-800 bg-gray-900/40 overflow-hidden"
              >
                <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-800/40 transition-colors">
                  <RoleBadge role={msg.role} />
                  <span className="text-xs text-gray-500">
                    Message {i + 1}
                  </span>
                  {isSystem && (
                    <span className="text-xs text-gray-600">
                      (system prompt - click to expand)
                    </span>
                  )}
                </summary>
                <div className="px-4 pb-4 pt-1 border-t border-gray-800/50">
                  <MessageContent message={msg} />
                </div>
              </details>
            );
          })}
        </div>
      </div>
    </div>
  );
}
