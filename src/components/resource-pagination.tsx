import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 20;

export function ResourcePagination({
  pageNumber,
  pageSize,
  hasNextPage,
  isFetching,
  onPreviousPage,
  onNextPage,
  onPageSizeChange,
  onRetry,
}: {
  pageNumber: number;
  pageSize: number;
  hasNextPage: boolean;
  isFetching: boolean;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onPageSizeChange: (pageSize: number) => void;
  onRetry?: () => void;
}) {
  return (
    <nav className="flex flex-wrap items-center justify-between gap-3" aria-label="Pagination">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onPreviousPage} disabled={pageNumber === 1 || isFetching}>
          <ChevronLeft className="size-3.5" />
          Previous
        </Button>
        <span className="min-w-16 text-center font-mono text-xs text-content-tertiary" aria-live="polite">
          Page {pageNumber}
        </span>
        <Button variant="outline" size="sm" onClick={onNextPage} disabled={!hasNextPage || isFetching}>
          Next
          <ChevronRight className="size-3.5" />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        {onRetry && (
          <Button variant="ghost" size="sm" onClick={onRetry}>
            <RotateCcw className="size-3.5" />
            Retry
          </Button>
        )}
        <Select value={String(pageSize)} onValueChange={(value) => onPageSizeChange(Number(value))}>
          <SelectTrigger aria-label="Page size" className="min-w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((value) => (
              <SelectItem key={value} value={String(value)}>
                {value} per page
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </nav>
  );
}
