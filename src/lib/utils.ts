import { TaskStatus } from "@/generated/prisma/enums";

export function relativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return `${diffSec} 秒前`;
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffHour < 24) return `${diffHour} 小时前`;
  if (diffDay < 30) return `${diffDay} 天前`;
  return date.toLocaleDateString("zh-CN");
}

export function formatDuration(start: Date, end?: Date | null): string {
  const endTime = end ? end.getTime() : Date.now();
  const diffMs = endTime - start.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);

  if (diffHour > 0) return `${diffHour}h ${diffMin % 60}m`;
  if (diffMin > 0) return `${diffMin}m ${diffSec % 60}s`;
  return `${diffSec}s`;
}

type StatusColor = "blue" | "yellow" | "purple" | "green" | "red";

export function getStatusColor(status: TaskStatus): StatusColor {
  switch (status) {
    case "analyzing":
    case "planning":
    case "implementing":
    case "testing":
      return "blue";
    case "clarifying":
    case "choosing":
      return "yellow";
    case "pr_created":
    case "revising":
      return "purple";
    case "merged":
      return "green";
    case "failed":
      return "red";
  }
}

export function getStatusClasses(status: TaskStatus): string {
  const color = getStatusColor(status);
  const map: Record<StatusColor, string> = {
    blue: "bg-blue-500/10 text-blue-400 ring-blue-500/20",
    yellow: "bg-yellow-500/10 text-yellow-400 ring-yellow-500/20",
    purple: "bg-purple-500/10 text-purple-400 ring-purple-500/20",
    green: "bg-green-500/10 text-green-400 ring-green-500/20",
    red: "bg-red-500/10 text-red-400 ring-red-500/20",
  };
  return map[color];
}

export function getStatusDotClasses(status: TaskStatus): string {
  const color = getStatusColor(status);
  const map: Record<StatusColor, string> = {
    blue: "bg-blue-400",
    yellow: "bg-yellow-400",
    purple: "bg-purple-400",
    green: "bg-green-400",
    red: "bg-red-400",
  };
  return map[color];
}
