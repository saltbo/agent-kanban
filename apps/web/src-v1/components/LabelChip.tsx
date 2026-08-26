import { X } from "lucide-react";

import { cn } from "../lib/utils";

interface LabelChipProps {
  name: string;
  color: string;
  description?: string;
  className?: string;
  onRemove?: () => void;
}

export function LabelChip({ name, color, description, className, onRemove }: LabelChipProps) {
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded-[4px] border px-1.5 font-mono text-[10px] font-medium leading-none",
        className,
      )}
      title={description || name}
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 32%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)`,
      }}
    >
      <span className="min-w-0 truncate">{name}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Delete label ${name}`}
          className="-mr-0.5 grid size-3.5 place-items-center rounded-[3px] text-current opacity-60 transition-opacity hover:opacity-100"
          onClick={onRemove}
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}
