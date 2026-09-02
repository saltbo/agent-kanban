import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AgentDetailPage } from "@/features/agents/AgentDetailPage";
import { AgentsPage } from "@/features/agents/AgentsPage";
import { AccountSettingsPage } from "@/features/auth/AccountSettingsPage";
import { AuthPage } from "@/features/auth/AuthPage";
import { OnboardingPage } from "@/features/auth/OnboardingPage";
import { BoardLabelsPage } from "@/features/boards/BoardLabelsPage";
import { BoardPage } from "@/features/boards/BoardPage";
import { BoardRedirect } from "@/features/boards/BoardRedirect";
import { BoardSettingsPage } from "@/features/boards/BoardSettingsPage";
import { NewBoardPage } from "@/features/boards/NewBoardPage";
import { SharePage } from "@/features/boards/SharePage";
import { LandingPage } from "@/features/landing/LandingPage";
import { MachineDetailPage } from "@/features/machines/MachineDetailPage";
import { MachinesPage } from "@/features/machines/MachinesPage";
import { RepositoriesPage } from "@/features/repositories/RepositoriesPage";
import { useSession } from "@/lib/auth-client";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();

  if (isPending) return null;
  if (!session) return <Navigate to="/auth" replace />;
  return <>{children}</>;
}

function RootRoute() {
  const { data: session, isPending } = useSession();

  if (isPending) return null;
  if (!session) return <LandingPage />;
  return <BoardRedirect />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/landing" element={<LandingPage />} />
        <Route path="/share/:slug" element={<SharePage />} />
        <Route path="/" element={<RootRoute />} />
        <Route
          path="/onboarding"
          element={
            <ProtectedRoute>
              <OnboardingPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/boards/new"
          element={
            <ProtectedRoute>
              <NewBoardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/boards/:boardId"
          element={
            <ProtectedRoute>
              <BoardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/boards/:boardId/settings"
          element={
            <ProtectedRoute>
              <BoardSettingsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/boards/:boardId/labels"
          element={
            <ProtectedRoute>
              <BoardLabelsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/repositories"
          element={
            <ProtectedRoute>
              <RepositoriesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/agents"
          element={
            <ProtectedRoute>
              <AgentsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/agents/:agentId"
          element={
            <ProtectedRoute>
              <AgentDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/machines"
          element={
            <ProtectedRoute>
              <MachinesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/machines/:machineId"
          element={
            <ProtectedRoute>
              <MachineDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <Navigate to="/settings/profile" replace />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings/*"
          element={
            <ProtectedRoute>
              <AccountSettingsPage />
            </ProtectedRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
