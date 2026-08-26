import { Check, ChevronDown } from "lucide-react";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

interface FilterBarProps {
  repositories: { id: string; name: string }[];
  labels: { name: string; color: string; description: string }[];
  activeRepository: string | null;
  activeLabel: string | null;
  onRepositoryChange: (repository: string | null) => void;
  onLabelChange: (label: string | null) => void;
}

const VISIBLE_LABEL_LIMIT = 6;

function labelStyle(label: { color: string }, active: boolean) {
  return {
    color: label.color,
    borderColor: `color-mix(in srgb, ${label.color} ${active ? 48 : 30}%, transparent)`,
    backgroundColor: `color-mix(in srgb, ${label.color} ${active ? 14 : 6}%, transparent)`,
  };
}

function splitLabels(labels: FilterBarProps["labels"], activeLabel: string | null) {
  const visible = labels.slice(0, VISIBLE_LABEL_LIMIT);
  if (!activeLabel || visible.some((label) => label.name === activeLabel)) return { visible, overflow: labels.slice(VISIBLE_LABEL_LIMIT) };

  const active = labels.find((label) => label.name === activeLabel);
  if (!active) return { visible, overflow: labels.slice(VISIBLE_LABEL_LIMIT) };

  return {
    visible: [...visible.slice(0, VISIBLE_LABEL_LIMIT - 1), active],
    overflow: labels.filter(
      (label) => !visible.slice(0, VISIBLE_LABEL_LIMIT - 1).some((item) => item.name === label.name) && label.name !== activeLabel,
    ),
  };
}

export function FilterBar({ repositories, labels, activeRepository, activeLabel, onRepositoryChange, onLabelChange }: FilterBarProps) {
  if (repositories.length === 0 && labels.length === 0) return null;
  const { visible, overflow } = splitLabels(labels, activeLabel);

  return (
    <div className="flex items-center justify-between gap-3 px-5 py-2.5 border-b border-border">
      {repositories.length > 0 && (
        <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Button variant={activeRepository === null ? "secondary" : "outline"} size="xs" onClick={() => onRepositoryChange(null)}>
            All repos
          </Button>
          {repositories.map((r) => (
            <Button key={r.id} variant={activeRepository === r.id ? "secondary" : "outline"} size="xs" onClick={() => onRepositoryChange(r.id)}>
              {r.name}
            </Button>
          ))}
        </div>
      )}
      {labels.length > 0 && (
        <div className="ml-auto flex max-w-[50%] shrink-0 justify-end gap-2 pb-1 max-md:max-w-full">
          <Button
            variant={activeLabel === null ? "secondary" : "outline"}
            size="xs"
            className="h-5 rounded-[4px] px-1.5 font-mono text-[10px] font-medium"
            onClick={() => onLabelChange(null)}
          >
            All labels
          </Button>
          {visible.map((label) => {
            const active = activeLabel === label.name;
            return (
              <Button
                key={label.name}
                variant="outline"
                size="xs"
                className="h-5 max-w-28 rounded-[4px] px-1.5 font-mono text-[10px] font-medium"
                onClick={() => onLabelChange(label.name)}
                title={label.description || label.name}
                style={labelStyle(label, active)}
              >
                <span className="min-w-0 truncate">{label.name}</span>
              </Button>
            );
          })}
          {overflow.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" size="xs" className="h-5 rounded-[4px] px-1.5 font-mono text-[10px] font-medium" />}
              >
                More
                <ChevronDown className="size-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-72 w-56">
                {overflow.map((label) => {
                  const active = activeLabel === label.name;
                  return (
                    <DropdownMenuItem
                      key={label.name}
                      className="cursor-pointer text-xs"
                      onClick={() => onLabelChange(label.name)}
                      title={label.description || label.name}
                    >
                      <span
                        className="size-2 shrink-0 rounded-[2px]"
                        style={{
                          backgroundColor: label.color,
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono">{label.name}</span>
                      {active && <Check className="size-3 text-accent" />}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </div>
  );
}
