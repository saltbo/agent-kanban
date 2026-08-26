import { Navigate } from "react-router-dom";
import { getLastBoardId, useBoards } from "../hooks/useBoard";

export function BoardRedirect() {
  const { boards, loading } = useBoards();

  if (loading) return null;

  const lastId = getLastBoardId();
  const target = lastId && boards.some((b: any) => b.id === lastId) ? lastId : boards[0]?.id;

  if (target) {
    return <Navigate to={`/boards/${target}`} replace />;
  }

  return <Navigate to="/onboarding" replace />;
}
