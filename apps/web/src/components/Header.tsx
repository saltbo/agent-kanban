import { CircleDotDashed, Settings, Tags } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useBoardMaintainers, useBoards } from "../hooks/useBoard";
import { api } from "../lib/api";
import { clearAuthToken, signOut, useSession } from "../lib/auth-client";
import { getTheme, setTheme, type Theme } from "../lib/theme";
import { AgentIdenticon } from "./AgentIdenticon";
import { BoardMaintainerDialog } from "./BoardMaintainerDialog";
import { BoardSwitcher } from "./BoardSwitcher";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Button, buttonVariants } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const navLinks = [
  { to: "/agents", label: "Agents" },
  { to: "/machines", label: "Machines" },
  { to: "/repositories", label: "Repositories" },
  { to: "/skills", label: "Skills" },
];

function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === "light") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    );
  }
  if (theme === "dark") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

export function Header() {
  const { data: session } = useSession();
  const user = session?.user as { name?: string; email?: string; image?: string; role?: string } | undefined;
  const isAdmin = user?.role === "admin";
  const { boards, refresh: refreshBoards } = useBoards();
  const { boardId } = useParams<{ boardId: string }>();

  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  const activeBoard = boards.find((b: any) => b.id === boardId);

  function cycleTheme() {
    const next: Theme = theme === "dark" ? "light" : theme === "light" ? "system" : "dark";
    setTheme(next);
    setThemeState(next);
  }

  function handleBoardSelect(id: string) {
    navigate(`/boards/${id}`);
  }

  async function handleBoardCreate(name: string, type: "dev" | "ops") {
    const created = await api.boards.create({ name, type });
    refreshBoards();
    if (created?.id) navigate(`/boards/${created.id}`);
  }

  async function handleSignOut() {
    await signOut();
    clearAuthToken();
    navigate("/auth");
  }

  return (
    <>
      <header className="flex items-center justify-between px-5 py-3 border-b border-border bg-surface-secondary">
        {/* Left: Logo + Board name */}
        <div className="flex items-center gap-2">
          <Link to="/" className="text-[15px] font-bold tracking-tight text-content-primary">
            Agent <span className="text-accent">Kanban</span>
          </Link>
          {activeBoard && (
            <>
              <span className="text-content-tertiary text-xs">/</span>
              <Button variant="ghost" size="sm" onClick={() => setSwitcherOpen(true)}>
                {activeBoard.name}
              </Button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Link
                      to={`/boards/${activeBoard.id}/settings`}
                      className={buttonVariants({ variant: "ghost", size: "icon-sm", className: "relative" })}
                      aria-label="Board settings"
                    >
                      <Settings className="size-3.5" />
                    </Link>
                  }
                />
                <TooltipContent>Board settings</TooltipContent>
              </Tooltip>
              <MaintainerControl boardId={activeBoard.id} />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Link
                      to={`/boards/${activeBoard.id}/labels`}
                      className={buttonVariants({ variant: "ghost", size: "icon-sm", className: "relative" })}
                      aria-label="Labels"
                    >
                      <Tags className="size-3.5" />
                    </Link>
                  }
                />
                <TooltipContent>Labels</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
        {/* Right: Nav + Theme + Avatar */}
        <div className="flex items-center gap-1">
          <nav className="hidden md:flex items-center gap-1">
            {navLinks.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                  location.pathname.startsWith(to)
                    ? "text-accent bg-accent-soft"
                    : "text-content-tertiary hover:text-content-secondary hover:bg-surface-tertiary"
                }`}
              >
                {label}
              </Link>
            ))}
          </nav>

          {/* Avatar + Dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="rounded-full" />}>
              <Avatar size="sm">
                {user?.image && <AvatarImage src={user.image} />}
                <AvatarFallback>{(user?.name || "?")[0].toUpperCase()}</AvatarFallback>
              </Avatar>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="w-48">
              {user && (
                <>
                  <div className="px-2 py-1.5">
                    <p className="text-sm font-medium text-content-primary truncate">{user.name || user.email}</p>
                    {user.name && user.email && <p className="text-xs text-content-tertiary truncate">{user.email}</p>}
                  </div>
                  <DropdownMenuSeparator />
                </>
              )}

              <DropdownMenuItem onClick={() => navigate("/settings/profile")}>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                Settings
              </DropdownMenuItem>

              {isAdmin && (
                <DropdownMenuItem onClick={() => navigate("/admin")}>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                  Admin
                </DropdownMenuItem>
              )}

              <DropdownMenuSeparator />

              <DropdownMenuItem onClick={handleSignOut}>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Theme toggle */}
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={cycleTheme} />}>
              <ThemeIcon theme={theme} />
            </TooltipTrigger>
            <TooltipContent>Theme: {theme}</TooltipContent>
          </Tooltip>
        </div>
      </header>

      {switcherOpen && (
        <BoardSwitcher
          boards={boards}
          activeBoardId={boardId ?? null}
          onSelect={handleBoardSelect}
          onCreate={handleBoardCreate}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
    </>
  );
}

function MaintainerControl({ boardId }: { boardId: string }) {
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [agent, setAgent] = useState<any | null>(null);
  const { maintainers } = useBoardMaintainers(boardId);
  const maintainer = maintainers[0] as { id: string; agent_id?: string; status?: string } | undefined;

  useEffect(() => {
    let cancelled = false;
    if (!maintainer?.agent_id) {
      setAgent(null);
      return;
    }
    api.agents
      .list()
      .then((agents) => {
        if (!cancelled) setAgent((agents ?? []).find((candidate: any) => candidate.id === maintainer.agent_id) ?? null);
      })
      .catch(() => {
        if (!cancelled) setAgent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [maintainer?.agent_id]);

  if (!maintainer) {
    return (
      <>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-sm" className="relative" aria-label="Add maintainer" onClick={() => setDialogOpen(true)}>
                <CircleDotDashed className="size-3.5" />
              </Button>
            }
          />
          <TooltipContent>Add maintainer</TooltipContent>
        </Tooltip>
        <BoardMaintainerDialog boardId={boardId} open={dialogOpen} onOpenChange={setDialogOpen} />
      </>
    );
  }

  const maintainerLabel = agent?.name ?? agent?.username ?? maintainer.agent_id ?? maintainer.id;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="relative rounded-md"
            aria-label={`View maintainer ${maintainerLabel}`}
            onClick={() => navigate(`/boards/${boardId}/maintainers/${maintainer.id}`)}
          >
            {agent?.public_key ? (
              <AgentIdenticon publicKey={agent.public_key} size={22} glow={maintainer.status === "active"} />
            ) : (
              <Avatar size="sm">
                <AvatarFallback>{maintainerLabel[0]?.toUpperCase() ?? "?"}</AvatarFallback>
              </Avatar>
            )}
          </Button>
        }
      />
      <TooltipContent>{maintainerLabel}</TooltipContent>
    </Tooltip>
  );
}
