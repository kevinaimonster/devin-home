export interface GitHubWebhookEvent {
  action: string;
  installation?: {
    id: number;
    account: {
      login: string;
      type: string;
    };
  };
  repository?: {
    owner: { login: string };
    name: string;
    full_name: string;
    default_branch: string;
  };
  issue?: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    labels: Array<{ name: string }>;
    user: { login: string };
  };
  label?: {
    name: string;
  };
  comment?: {
    body: string;
    user: { login: string };
  };
  pull_request?: {
    number: number;
    html_url: string;
  };
  review?: {
    state: string;
    body: string | null;
  };
}

export interface DispatchResult {
  action: "create_task" | "clarify" | "resume_task" | "handle_review" | "ignore";
  taskId?: string;
  message?: string;
}

export interface WorkerResult {
  success: boolean;
  branchName?: string;
  prNumber?: number;
  prUrl?: string;
  summary?: string;
  error?: string;
  tokenUsage?: number;
}
