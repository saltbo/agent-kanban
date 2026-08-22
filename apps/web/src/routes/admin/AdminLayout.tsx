import { BarChart3, ChevronLeft, LayoutDashboard, Server } from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";

const navItems = [
  { to: "/admin", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/admin/machines", label: "Machines", icon: Server },
];

export function AdminLayout() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-surface-primary flex">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 fixed top-0 left-0 h-full flex flex-col bg-surface-secondary border-r border-border">
        <div className="px-4 py-4 border-b border-border">
          <button
            onClick={() => navigate("/")}
            className="flex items-center gap-1.5 text-xs text-content-tertiary hover:text-content-primary transition-colors"
          >
            <ChevronLeft size={14} />
            Back to Board
          </button>
        </div>

        <div className="px-4 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <BarChart3 size={16} className="text-accent" />
            <span className="text-sm font-semibold text-content-primary tracking-tight">Admin</span>
          </div>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors border-l-2 ${
                  isActive
                    ? "text-accent bg-surface-tertiary border-l-accent"
                    : "text-content-tertiary hover:text-content-primary hover:bg-surface-tertiary border-l-transparent"
                }`
              }
            >
              <Icon size={15} />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 ml-56 min-h-screen">
        <Outlet />
      </main>
    </div>
  );
}
