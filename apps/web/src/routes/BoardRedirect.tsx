import { Navigate } from "react-router-dom";
import { getLastBoardId, useBoards } from "../hooks/useBoard";

export function BoardRedirect() {
  const { boards, loading, error } = useBoards();

  if (loading) return null;
  if (error)
    return (
      <div className="min-h-screen bg-surface-primary">
        <p role="alert" className="mx-auto mt-8 max-w-4xl rounded-lg border border-error/30 bg-error/5 p-4 text-sm text-error">
          {(error as Error).message}
        </p>
      </div>
    );

  const lastId = getLastBoardId();
  const target = lastId && boards.some((b: any) => b.id === lastId) ? lastId : boards[0]?.id;

  if (target) {
    return <Navigate to={`/boards/${target}`} replace />;
  }

  return <Navigate to="/boards/new" replace />;
}
