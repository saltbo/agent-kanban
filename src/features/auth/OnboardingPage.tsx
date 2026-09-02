import { useNavigate } from "react-router-dom";
import { Header } from "@/features/boards/components/Header";
import { DemoBoard } from "@/features/landing/DemoBoard";

export function OnboardingPage() {
  const navigate = useNavigate();
  const go = () => navigate("/boards/new");

  return (
    <div className="min-h-screen bg-surface-primary">
      <Header />
      <div className="p-4">
        <DemoBoard onContinue={go} onSkip={go} />
      </div>
    </div>
  );
}
