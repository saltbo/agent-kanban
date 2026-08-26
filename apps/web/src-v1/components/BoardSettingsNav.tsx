import { useLocation, useNavigate } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

interface BoardSettingsNavProps {
  boardId: string;
}

const items = [
  { path: "settings", label: "Settings" },
  { path: "labels", label: "Labels" },
];

export function BoardSettingsNav({ boardId }: BoardSettingsNavProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const value = items.find((item) => location.pathname === `/boards/${boardId}/${item.path}`)?.path ?? "settings";

  return (
    <Tabs value={value} onValueChange={(nextValue) => navigate(`/boards/${boardId}/${nextValue}`)}>
      <TabsList variant="line" aria-label="Board settings sections" className="border-b border-border">
        {items.map((item) => (
          <TabsTrigger key={item.path} value={item.path} aria-current={value === item.path ? "page" : undefined} className="px-3 text-xs">
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
