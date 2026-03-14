import Link from "next/link";
import { prisma } from "@/lib/db";
import { TaskStatus } from "@/generated/prisma/enums";
import {
  relativeTime,
  formatDuration,
  getStatusClasses,
} from "@/lib/utils";

export const dynamic = "force-dynamic";

const IN_PROGRESS: TaskStatus[] = [
  "analyzing",
  "planning",
  "implementing",
  "testing",
];
const WAITING: TaskStatus[] = ["clarifying", "choosing"];
const REVIEW: TaskStatus[] = ["pr_created", "revising"];

export default async function Home() {
  const tasks = await prisma.task.findMany({
    orderBy: { createdAt: "desc" },
    include: { installation: true },
  });

  const total = tasks.length;
  const inProgress = tasks.filter(
    (t) =>
      IN_PROGRESS.includes(t.status) ||
      WAITING.includes(t.status) ||
      REVIEW.includes(t.status)
  ).length;
  const completed = tasks.filter((t) => t.status === "merged").length;
  const failed = tasks.filter((t) => t.status === "failed").length;

  const stats = [
    { label: "总任务", value: total, color: "text-white" },
    { label: "进行中", value: inProgress, color: "text-blue-400" },
    { label: "已完成", value: completed, color: "text-green-400" },
    { label: "失败", value: failed, color: "text-red-400" },
  ];

  return (
    <div>
      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 mb-8">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-lg border border-gray-800 bg-gray-800/50 p-4"
          >
            <p className="text-sm text-gray-400">{stat.label}</p>
            <p className={`mt-1 text-2xl font-semibold ${stat.color}`}>
              {stat.value}
            </p>
          </div>
        ))}
      </div>

      {/* Task List */}
      <div className="space-y-2">
        {tasks.length === 0 && (
          <div className="rounded-lg border border-gray-800 bg-gray-800/30 p-12 text-center text-gray-500">
            暂无任务
          </div>
        )}
        {tasks.map((task) => (
          <Link
            key={task.id}
            href={`/tasks/${task.id}`}
            className="block rounded-lg border border-gray-800 bg-gray-800/30 p-4 hover:bg-gray-800/60 hover:border-gray-700 transition-colors"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3 mb-1">
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${getStatusClasses(task.status)}`}
                  >
                    {task.status}
                  </span>
                  <span className="text-xs text-gray-500">
                    {task.repoOwner}/{task.repoName} #{task.issueNumber}
                  </span>
                </div>
                <h3 className="text-sm font-medium text-gray-100 truncate">
                  {task.issueTitle}
                </h3>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0 text-xs text-gray-500">
                <span>{relativeTime(task.createdAt)}</span>
                <span className="font-mono">
                  {formatDuration(task.startedAt, task.completedAt)}
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
