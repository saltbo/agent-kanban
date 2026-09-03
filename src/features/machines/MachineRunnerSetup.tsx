import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

interface MachineRunnerSetupProps {
  authCommand: string;
  startCommand: string;
}

export function MachineRunnerSetup({ authCommand, startCommand }: MachineRunnerSetupProps) {
  return (
    <div className="flex flex-col gap-3">
      <Command label="1. Authenticate" value={authCommand} />
      <Command label="2. Start this Machine" value={startCommand} />
      <p className="text-xs leading-5 text-content-tertiary">
        AMA Runner must already be installed. If it is not, install the latest release from{" "}
        <a className="text-accent underline underline-offset-2" href="https://github.com/realmroot/agency/releases" target="_blank" rel="noreferrer">
          Realmroot Agency releases
        </a>
        .
      </p>
    </div>
  );
}

function Command({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs font-medium text-content-secondary">{label}</div>
      <div className="flex items-start gap-2 rounded-md border border-border bg-surface-primary p-3">
        <code className="min-w-0 flex-1 break-all font-mono text-xs leading-5 text-content-primary">{value}</code>
        <Button variant="ghost" size="icon-sm" aria-label={`Copy ${label}`} onClick={copy}>
          {copied ? <Check className="text-success" /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}
