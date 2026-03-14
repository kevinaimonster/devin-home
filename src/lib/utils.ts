export type TaskStatus = "working" | "waiting" | "done" | "error" | "unknown";

export function relativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString("en-US");
}

export function getStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "working": return "Working";
    case "waiting": return "Waiting";
    case "done": return "Done";
    case "error": return "Error";
    case "unknown": return "Unknown";
  }
}

export function getStatusClasses(status: TaskStatus): string {
  switch (status) {
    case "working":
      return "bg-blue-500/10 text-blue-400 ring-blue-500/20";
    case "waiting":
      return "bg-yellow-500/10 text-yellow-400 ring-yellow-500/20";
    case "done":
      return "bg-green-500/10 text-green-400 ring-green-500/20";
    case "error":
      return "bg-red-500/10 text-red-400 ring-red-500/20";
    case "unknown":
      return "bg-gray-500/10 text-gray-400 ring-gray-500/20";
  }
}
