import { readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";

export interface ResourceDoc {
  kind: string;
  metadata?: Record<string, unknown>;
  spec: Record<string, unknown>;
}

const CAMEL_TO_SNAKE: Record<string, string> = {
  boardId: "board_id",
  assignTo: "assigned_to",
  dependsOn: "depends_on",
  createdFrom: "created_from",
  scheduledAt: "scheduled_at",
  repositoryId: "repository_id",
  handoffTo: "handoff_to",
  prUrl: "pr_url",
};

function convertSpec(raw: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const mapped = CAMEL_TO_SNAKE[key] ?? key;
    result[mapped] = value;
  }
  return result;
}

function readInput(file: string): string {
  if (file === "-") return readFileSync("/dev/stdin", "utf-8");
  return readFileSync(file, "utf-8");
}

export function parseResourceDocs(file: string): ResourceDoc[] {
  const content = readInput(file);
  const trimmed = content.trimStart();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(content) as unknown;
    const docs = Array.isArray(parsed) ? parsed : [parsed];
    return docs.map((d: any) => ({
      kind: d.kind as string,
      metadata: d.metadata as Record<string, unknown> | undefined,
      spec: convertSpec(d.spec as Record<string, unknown>),
    }));
  }

  const documents = parseAllDocuments(content);
  return documents.map((doc) => {
    const data = doc.toJS() as { kind: string; metadata?: Record<string, unknown>; spec: Record<string, unknown> };
    return {
      kind: data.kind,
      metadata: data.metadata,
      spec: convertSpec(data.spec),
    };
  });
}
