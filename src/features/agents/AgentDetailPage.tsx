import { ChevronLeft } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AgentDetail } from "@/features/agents/AgentProjectionPages";
import { useAgent, useAgentTasks } from "@/features/agents/useAgents";
import { Header } from "@/features/boards/components/Header";

export function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const { data, isLoading, error } = useAgent(agentId);
  const tasks = useAgentTasks(data?.subject);
  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <main className="mx-auto max-w-4xl space-y-6 p-8">
        <Link to="/agents" className="inline-flex items-center gap-1 text-xs text-content-tertiary hover:text-accent">
          <ChevronLeft className="size-3.5" />
          Agents
        </Link>
        {error ? (
          <p className="text-sm text-error">{error.message}</p>
        ) : isLoading || !data ? (
          <div className="h-40 animate-pulse rounded-lg border border-border bg-surface-secondary" />
        ) : (
          <>
            <AgentDetail agent={data} />
            <Card className="rounded-lg border-border bg-surface-secondary">
              <CardHeader>
                <CardTitle>Assigned tasks</CardTitle>
              </CardHeader>
              <CardContent>
                {tasks.error ? (
                  <p className="text-sm text-error">{tasks.error.message}</p>
                ) : tasks.isLoading ? (
                  <div className="h-16 animate-pulse rounded-md bg-surface-tertiary" />
                ) : !tasks.data?.length ? (
                  <p className="text-sm text-content-tertiary">No tasks are currently assigned to this Agent.</p>
                ) : (
                  <div className="space-y-2">
                    {tasks.data.map((task) => (
                      <Link
                        key={task.id}
                        to={`/boards/${encodeURIComponent(task.board_id)}`}
                        className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2 hover:border-accent/40"
                      >
                        <span className="min-w-0 truncate text-sm text-content-primary">{task.title}</span>
                        <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                          {task.status.replaceAll("_", " ")}
                        </Badge>
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
