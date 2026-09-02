/**
 * Canonical tool registry.
 *
 * Every tool is a single discriminated-union member: { name, input }.
 * The `name` field is the discriminant; `input` is the canonical arg shape.
 *
 * Derive everything from `Tool` — don't maintain a separate name list or
 * arg-map; TypeScript infers them automatically:
 *
 *   type ToolName  = Tool["name"]
 *   type ToolInput<N extends ToolName> = Extract<Tool, { name: N }>["input"]
 *
 * Adding a new tool: add one union member here, then register its UI in
 * tool-uis.tsx and add a mapping case in each provider normalizer.
 */

// ─── Arg types ────────────────────────────────────────────────────────────────
// Co-located with the registry so name and shape are always in one place.

export type BashArgs = {
  command: string;
  description?: string;
  timeout?: number;
};

export type ReadArgs = {
  filePath: string;
  offset?: number;
  limit?: number;
};

export type EditArgs = {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
};

export type MultiEditArgs = {
  filePath: string;
  edits: { oldString: string; newString: string; replaceAll?: boolean }[];
};

export type WriteArgs = {
  filePath: string;
  content: string;
};

export type GrepArgs = {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  outputMode?: string;
};

export type GlobArgs = {
  pattern: string;
  path?: string;
};

export type TaskArgs = {
  description: string;
  prompt: string;
  subagentType?: string;
};

export type TodoItem = {
  content: string;
  status: "pending" | "in_progress" | "completed";
};

export type TodoArgs = {
  todos: TodoItem[];
};

export type WebFetchArgs = {
  url: string;
  prompt: string;
};

export type WebSearchArgs = {
  query: string;
};

export type WebSearchResultItem = {
  title?: string;
  url?: string;
  snippet?: string;
};

export type WebSearchResult = WebSearchResultItem[] | string;

export type AskUserQuestionOption = {
  label?: string;
  description?: string;
};

export type AskUserQuestion = {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options?: AskUserQuestionOption[];
};

export type AskUserQuestionArgs = {
  questions: AskUserQuestion[];
};

export type ExitPlanModeArgs = {
  plan: string;
};

export type SlashCommandArgs = {
  command: string;
};

export type NotebookEditArgs = {
  notebookPath: string;
  cellId?: string;
  cellType?: "code" | "markdown";
  editMode?: "replace" | "insert" | "delete";
  newSource: string;
};

// ─── Tool registry (discriminated union) ──────────────────────────────────────

/** The canonical union of all tools. Discriminated by `name`. */
export type Tool =
  | { name: "Bash"; input: BashArgs }
  | { name: "Read"; input: ReadArgs }
  | { name: "Edit"; input: EditArgs }
  | { name: "MultiEdit"; input: MultiEditArgs }
  | { name: "Write"; input: WriteArgs }
  | { name: "Grep"; input: GrepArgs }
  | { name: "Glob"; input: GlobArgs }
  | { name: "Agent"; input: TaskArgs }
  | { name: "TodoWrite"; input: TodoArgs }
  | { name: "WebFetch"; input: WebFetchArgs }
  | { name: "WebSearch"; input: WebSearchArgs }
  | { name: "AskUserQuestion"; input: AskUserQuestionArgs }
  | { name: "ExitPlanMode"; input: ExitPlanModeArgs }
  | { name: "SlashCommand"; input: SlashCommandArgs }
  | { name: "NotebookEdit"; input: NotebookEditArgs };

/** All canonical tool names, derived from the union. */
export type ToolName = Tool["name"];

/** Input arg type for a specific tool name, derived from the union. */
export type ToolInput<N extends ToolName> = Extract<Tool, { name: N }>["input"];

/**
 * Runtime name constants for use in switch statements and provider mappers.
 * `satisfies Record<ToolName, ToolName>` enforces that every union member is
 * represented — forgetting an entry is a compile error.
 */
export const ToolName = {
  Bash: "Bash",
  Read: "Read",
  Edit: "Edit",
  MultiEdit: "MultiEdit",
  Write: "Write",
  Grep: "Grep",
  Glob: "Glob",
  Agent: "Agent",
  TodoWrite: "TodoWrite",
  WebFetch: "WebFetch",
  WebSearch: "WebSearch",
  AskUserQuestion: "AskUserQuestion",
  ExitPlanMode: "ExitPlanMode",
  SlashCommand: "SlashCommand",
  NotebookEdit: "NotebookEdit",
} as const satisfies Record<ToolName, ToolName>;
