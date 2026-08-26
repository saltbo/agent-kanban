import type { ToolCallMessagePartStatus } from "@assistant-ui/react";
import { AlertCircleIcon, LoaderIcon, XCircleIcon } from "lucide-react";
import { Highlight, themes as prismThemes } from "prism-react-renderer";
import { type FC, type ReactNode, useSyncExternalStore } from "react";
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

// ─── Shared shell ───────────────────────────────────────────────────────────
// Compact collapsible row: [status icon] [tool-icon] LABEL summary…
// Built directly on Collapsible primitive so the trigger row is fully custom.

interface ToolShellProps {
  icon: ReactNode;
  label: string;
  summary: ReactNode;
  status?: ToolCallMessagePartStatus;
  children?: ReactNode;
}

const StatusIcon: FC<{ status?: ToolCallMessagePartStatus }> = ({ status }) => {
  if (!status || status.type === "complete") return null;
  if (status.type === "running") return <LoaderIcon className="size-3 shrink-0 animate-spin text-content-tertiary" />;
  if (status.type === "requires-action") return <AlertCircleIcon className="size-3 shrink-0 text-accent" />;
  if (status.type === "incomplete")
    return <XCircleIcon className={cn("size-3 shrink-0", status.reason === "cancelled" ? "text-content-tertiary" : "text-destructive")} />;
  return null;
};

export const ToolShell: FC<ToolShellProps> = ({ icon, label, summary, status, children }) => {
  const isCancelled = status?.type === "incomplete" && status.reason === "cancelled";
  const errorText =
    status?.type === "incomplete" && status.error ? (typeof status.error === "string" ? status.error : JSON.stringify(status.error)) : null;
  return (
    <Collapsible className={cn("group/tool w-full", isCancelled && "opacity-60")}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/40">
        <StatusIcon status={status} />
        <span className="shrink-0 text-content-tertiary">{icon}</span>
        <span className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wide text-content-secondary">{label}</span>
        <span className={cn("min-w-0 flex-1 truncate font-mono text-content-primary", isCancelled && "line-through")}>{summary}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <div className="pl-6 pr-1.5 pt-2 pb-2 overflow-x-hidden">
          {errorText && (
            <div className="mb-2 rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">{errorText}</div>
          )}
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

// ─── Theme detection ────────────────────────────────────────────────────────
// Subscribes to `.dark` class changes on <html> so diff viewer and syntax
// highlighter switch themes in sync with the rest of the app.

function subscribeDarkMode(cb: () => void): () => void {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => obs.disconnect();
}
function getDarkModeSnapshot(): boolean {
  return document.documentElement.classList.contains("dark");
}
function useIsDarkMode(): boolean {
  return useSyncExternalStore(
    subscribeDarkMode,
    getDarkModeSnapshot,
    () => false, // SSR fallback — light by default
  );
}

// ─── CodeBlock ───────────────────────────────────────────────────────────────
// Syntax-highlighted, via prism-react-renderer. Falls back to plain pre if
// lang is omitted. `plain` skips tokenization entirely (for raw shell output
// where pretending to highlight adds nothing).

const EXT_TO_LANG: Record<string, string> = {
  ts: "tsx",
  tsx: "tsx",
  js: "jsx",
  jsx: "jsx",
  mjs: "jsx",
  cjs: "jsx",
  json: "json",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  sql: "sql",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  css: "css",
  scss: "scss",
};

export function langFromPath(path?: string): string | undefined {
  if (!path) return undefined;
  const m = path.match(/\.([a-z0-9]+)$/i);
  return m ? EXT_TO_LANG[m[1].toLowerCase()] : undefined;
}

interface CodeBlockProps {
  children: string;
  lang?: string;
  className?: string;
  /** Skip tokenization — use for raw terminal output. */
  plain?: boolean;
}

export const CodeBlock: FC<CodeBlockProps> = ({ children, lang, className, plain }) => {
  const isDark = useIsDarkMode();
  const baseCls =
    "max-h-64 overflow-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap break-all";

  if (plain || !lang) {
    return <pre className={cn(baseCls, "text-content-primary", className)}>{children}</pre>;
  }

  const theme = isDark ? prismThemes.vsDark : prismThemes.vsLight;
  return (
    <Highlight theme={theme} code={children} language={lang}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre className={cn(baseCls, "!bg-muted/30", className)}>
          {tokens.map((line, i) => {
            const { key: _lineKey, ...lineProps } = getLineProps({ line });
            return (
              <div key={i} {...lineProps}>
                {line.map((token, j) => {
                  const { key: _tokenKey, ...tokenProps } = getTokenProps({ token });
                  return <span key={j} {...tokenProps} />;
                })}
              </div>
            );
          })}
        </pre>
      )}
    </Highlight>
  );
};

// Kept as an alias so other tools (Mono-style plain output) still read well.
export const Mono: FC<{ children: ReactNode; className?: string }> = ({ children, className }) => (
  <CodeBlock plain className={className}>
    {typeof children === "string" ? children : String(children)}
  </CodeBlock>
);

// Coerce a tool result (which may be string / object / { error }) into plain
// text. Keeps the per-tool UIs free of this plumbing.
export function resultText(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.error === "string") return r.error;
    if (typeof r.output === "string") return r.output;
    return JSON.stringify(result, null, 2);
  }
  return String(result);
}

// ─── FileDiff ────────────────────────────────────────────────────────────────
// Reusable single-hunk unified diff backed by react-diff-viewer-continued.
// Provides: line numbers, word-level highlight, split/unified toggle, and
// automatic light/dark theming.

// Palettes for the diff viewer. Keyed on dark-mode flag. Intentionally
// ignores the rdv built-in themes because they use flat reds/greens that
// blow out contrast against the chat surface.
const DIFF_PALETTE = {
  dark: {
    diffViewerBackground: "transparent",
    diffViewerColor: "#FAFAFA",
    addedBackground: "rgba(34, 197, 94, 0.14)",
    addedColor: "#86efac",
    removedBackground: "rgba(239, 68, 68, 0.14)",
    removedColor: "#fca5a5",
    wordAddedBackground: "rgba(34, 197, 94, 0.35)",
    wordRemovedBackground: "rgba(239, 68, 68, 0.35)",
    addedGutterBackground: "rgba(34, 197, 94, 0.20)",
    removedGutterBackground: "rgba(239, 68, 68, 0.20)",
    gutterBackground: "transparent",
    gutterBackgroundDark: "transparent",
    highlightBackground: "rgba(255, 255, 255, 0.04)",
    highlightGutterBackground: "rgba(255, 255, 255, 0.06)",
    codeFoldGutterBackground: "transparent",
    codeFoldBackground: "transparent",
    emptyLineBackground: "transparent",
    gutterColor: "rgba(255, 255, 255, 0.35)",
    addedGutterColor: "rgba(134, 239, 172, 0.85)",
    removedGutterColor: "rgba(252, 165, 165, 0.85)",
    codeFoldContentColor: "rgba(255, 255, 255, 0.5)",
    diffViewerTitleBackground: "transparent",
    diffViewerTitleColor: "rgba(255, 255, 255, 0.6)",
    diffViewerTitleBorderColor: "rgba(255, 255, 255, 0.1)",
  },
  light: {
    diffViewerBackground: "transparent",
    diffViewerColor: "#09090B",
    addedBackground: "rgba(34, 197, 94, 0.12)",
    addedColor: "#166534",
    removedBackground: "rgba(239, 68, 68, 0.12)",
    removedColor: "#991b1b",
    wordAddedBackground: "rgba(34, 197, 94, 0.32)",
    wordRemovedBackground: "rgba(239, 68, 68, 0.32)",
    addedGutterBackground: "rgba(34, 197, 94, 0.18)",
    removedGutterBackground: "rgba(239, 68, 68, 0.18)",
    gutterBackground: "transparent",
    gutterBackgroundDark: "transparent",
    highlightBackground: "rgba(0, 0, 0, 0.04)",
    highlightGutterBackground: "rgba(0, 0, 0, 0.06)",
    codeFoldGutterBackground: "transparent",
    codeFoldBackground: "transparent",
    emptyLineBackground: "transparent",
    gutterColor: "rgba(9, 9, 11, 0.45)",
    addedGutterColor: "rgba(22, 101, 52, 0.85)",
    removedGutterColor: "rgba(153, 27, 27, 0.85)",
    codeFoldContentColor: "rgba(9, 9, 11, 0.55)",
    diffViewerTitleBackground: "transparent",
    diffViewerTitleColor: "rgba(9, 9, 11, 0.6)",
    diffViewerTitleBorderColor: "rgba(9, 9, 11, 0.1)",
  },
};

export const FileDiff: FC<{ oldStr: string; newStr: string }> = ({ oldStr, newStr }) => {
  const isDark = useIsDarkMode();
  return (
    <div className="overflow-hidden rounded-md border border-border/60 bg-background/60 text-[11px] [&_pre]:!font-mono [&_pre]:!text-[11px] [&_pre]:!leading-[1.55]">
      <ReactDiffViewer
        oldValue={oldStr}
        newValue={newStr}
        splitView={false}
        hideLineNumbers={false}
        compareMethod={DiffMethod.WORDS}
        useDarkTheme={isDark}
        styles={{
          variables: {
            dark: DIFF_PALETTE.dark,
            light: DIFF_PALETTE.light,
          },
          contentText: { fontFamily: "inherit" },
          gutter: { minWidth: "2.5em", padding: "0 0.5em" },
        }}
      />
    </div>
  );
};

// ─── Markdown helper ─────────────────────────────────────────────────────────

export const Markdown: FC<{ text: string }> = ({ text }) => (
  <div className="prose prose-sm max-w-none text-[12px] leading-relaxed [&_code]:rounded [&_code]:bg-muted/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11px] [&_pre]:my-1.5 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:border [&_pre]:border-border/60 [&_pre]:bg-muted/30 [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_p]:my-1 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_h1]:mt-2 [&_h1]:mb-1 [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-[13px] [&_h2]:font-semibold">
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
  </div>
);

// ─── MCP tool name parser ────────────────────────────────────────────────────

/**
 * Split an MCP tool name into namespace + tool parts.
 * `mcp.chrome_devtools.click` → { ns: "chrome_devtools", name: "click" }
 * `mcp__chrome_devtools__click` → { ns: "chrome_devtools", name: "click" }
 * Returns null for non-MCP names.
 */
export function parseMcpToolName(toolName: string): { ns: string; name: string } | null {
  if (toolName.startsWith("mcp.")) {
    const rest = toolName.slice(4);
    const idx = rest.lastIndexOf(".");
    if (idx === -1) return { ns: "mcp", name: rest };
    return { ns: rest.slice(0, idx), name: rest.slice(idx + 1) };
  }
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice(5);
  const idx = rest.indexOf("__");
  if (idx === -1) return { ns: "mcp", name: rest };
  return { ns: rest.slice(0, idx), name: rest.slice(idx + 2) };
}
