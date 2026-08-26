import { useNavigate } from "react-router-dom";
import { DemoBoard } from "../components/DemoBoard";
import { Header } from "../components/Header";

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
