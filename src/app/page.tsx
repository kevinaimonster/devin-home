import Link from "next/link";
import {
  relativeTime,
  getStatusLabel,
  getStatusClasses,
} from "@/lib/utils";
import type { TaskStatus } from "@/lib/utils";

export const dynamic = "force-dynamic";

const SERVER_URL =
  process.env.NEXT_PUBLIC_DEVIN_SERVER_URL ?? "http://43.173.120.86:3001";

interface TaskSummary {
  owner: string;
  repo: string;
  issueNumber: number;
  messageCount: number;
  lastUpdated: string | null;
  status: TaskStatus;
  lastAssistantPreview: string;
}

async function fetchTasks(): Promise<TaskSummary[]> {
  try {
    const res = await fetch(`${SERVER_URL}/api/tasks`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export default async function Home() {
  const tasks = await fetchTasks();

  const total = tasks.length;
  const active = tasks.filter(
    (t) => t.status === "working" || t.status === "waiting"
  ).length;
  const completed = tasks.filter((t) => t.status === "done").length;

  const stats = [
    { label: "Total Tasks", value: total, color: "text-white" },
    { label: "Active", value: active, color: "text-blue-400" },
    { label: "Completed", value: completed, color: "text-green-400" },
  ];

  return (
    <div>
      {/* Header */}
      <h1 className="text-2xl font-bold text-white mb-6">Devin Dashboard</h1>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-lg border border-gray-800 bg-gray-900/60 p-5"
          >
            <p className="text-sm text-gray-400">{stat.label}</p>
            <p className={`mt-1 text-3xl font-semibold ${stat.color}`}>
              {stat.value}
            </p>
          </div>
        ))}
      </div>

      {/* Task List */}
      <div className="space-y-2">
        {tasks.length === 0 && (
          <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-12 text-center text-gray-500">
            No tasks found. Make sure the Devin server is running at{" "}
            <code className="text-gray-400">{SERVER_URL}</code>
          </div>
        )}
        {tasks.map((task) => (
          <Link
            key={`${task.owner}_${task.repo}_${task.issueNumber}`}
            href={`/tasks/${task.owner}/${task.repo}/${task.issueNumber}`}
            className="block rounded-lg border border-gray-800 bg-gray-900/40 p-4 hover:bg-gray-800/60 hover:border-gray-700 transition-colors"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3 mb-1">
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${getStatusClasses(task.status)}`}
                  >
                    {getStatusLabel(task.status)}
                  </span>
                  <span className="text-sm text-gray-300 font-medium">
                    {task.owner}/{task.repo}
                  </span>
                  <span className="text-sm text-gray-500">
                    #{task.issueNumber}
                  </span>
                </div>
                {task.lastAssistantPreview && (
                  <p className="text-xs text-gray-500 mt-1 truncate">
                    {task.lastAssistantPreview}
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0 text-xs text-gray-500">
                {task.lastUpdated && (
                  <span>{relativeTime(task.lastUpdated)}</span>
                )}
                <span className="font-mono text-gray-600">
                  {task.messageCount} msgs
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
