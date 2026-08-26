export interface UsageWindow {
  utilization: number;
  resets_at: string;
}

export interface UsageInfo {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  seven_day_sonnet?: UsageWindow;
  seven_day_opus?: UsageWindow;
  updated_at: string;
}

export type WorkspaceInfo = { type: "repo"; cwd: string; repoDir: string; branchName: string } | { type: "temp"; cwd: string };
