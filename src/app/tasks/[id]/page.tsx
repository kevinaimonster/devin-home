import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import {
  relativeTime,
  formatDuration,
  getStatusClasses,
  getStatusDotClasses,
} from "@/lib/utils";

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const task = await prisma.task.findUnique({
    where: { id },
    include: {
      installation: true,
      logs: { orderBy: { createdAt: "asc" } },
    },
  });

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
        返回任务列表
      </Link>

      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${getStatusClasses(task.status)}`}
          >
            {task.status}
          </span>
          <span className="text-sm text-gray-500">
            {task.repoOwner}/{task.repoName} #{task.issueNumber}
          </span>
        </div>
        <h1 className="text-2xl font-semibold text-white">
          {task.issueTitle}
        </h1>
      </div>

      {/* Info Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <InfoCard label="创建时间" value={relativeTime(task.createdAt)} />
        <InfoCard
          label="耗时"
          value={formatDuration(task.startedAt, task.completedAt)}
        />
        <InfoCard label="Token 用量" value={task.tokenUsage.toLocaleString()} />
        <InfoCard
          label="账号"
          value={task.installation.accountLogin}
        />
      </div>

      {/* Links */}
      <div className="flex flex-wrap gap-3">
        <a
          href={task.issueUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800/50 px-4 py-2 text-sm text-gray-300 hover:text-white hover:border-gray-600 transition-colors"
        >
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 16 16">
            <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
          </svg>
          Issue
        </a>
        {task.prUrl && (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800/50 px-4 py-2 text-sm text-gray-300 hover:text-white hover:border-gray-600 transition-colors"
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 16 16">
              <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
            </svg>
            Pull Request #{task.prNumber}
          </a>
        )}
      </div>

      {/* Plan Summary */}
      {task.planSummary && (
        <div className="rounded-lg border border-gray-800 bg-gray-800/30 p-5">
          <h2 className="mb-3 text-sm font-medium text-gray-400 uppercase tracking-wider">
            方案摘要
          </h2>
          <p className="text-sm leading-relaxed text-gray-300 whitespace-pre-wrap">
            {task.planSummary}
          </p>
        </div>
      )}

      {/* Error Message */}
      {task.status === "failed" && task.errorMessage && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-5">
          <h2 className="mb-3 text-sm font-medium text-red-400 uppercase tracking-wider">
            错误信息
          </h2>
          <pre className="text-sm text-red-300 whitespace-pre-wrap font-mono">
            {task.errorMessage}
          </pre>
        </div>
      )}

      {/* Timeline */}
      <div>
        <h2 className="mb-4 text-sm font-medium text-gray-400 uppercase tracking-wider">
          状态时间线
        </h2>
        {task.logs.length === 0 ? (
          <p className="text-sm text-gray-500">暂无日志</p>
        ) : (
          <div className="relative space-y-0">
            {/* Vertical line */}
            <div className="absolute left-[7px] top-2 bottom-2 w-px bg-gray-800" />

            {task.logs.map((log) => (
              <div key={log.id} className="relative flex gap-4 pb-6 last:pb-0">
                {/* Dot */}
                <div className="relative z-10 mt-1.5">
                  <div
                    className={`h-[15px] w-[15px] rounded-full border-2 border-gray-900 ${getStatusDotClasses(task.status)}`}
                  />
                </div>
                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-gray-200">
                      {log.phase}
                    </span>
                    <span className="text-xs text-gray-500">
                      {relativeTime(log.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-gray-400 whitespace-pre-wrap">
                    {log.message}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-800/30 p-4">
      <p className="text-xs text-gray-500 uppercase tracking-wider">{label}</p>
      <p className="mt-1 text-lg font-medium text-gray-100">{value}</p>
    </div>
  );
}
