import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { AgentIdenticon } from "./AgentIdenticon";
import type { AgentProfile } from "./agentProfileApi";

interface AgentAvatarProps {
  subject: string;
  profile?: AgentProfile;
  fallbackName?: string | null;
  size?: number;
  className?: string;
  glow?: boolean;
  crystallize?: boolean;
}

export function AgentAvatar({ subject, profile, fallbackName, size = 28, className, glow, crystallize }: AgentAvatarProps) {
  const name = profile?.name || fallbackName || subject;
  return (
    <Avatar className={className} style={{ width: size, height: size }}>
      {profile?.picture && <AvatarImage src={profile.picture} alt={`${name} avatar`} referrerPolicy="no-referrer" />}
      <AvatarFallback>
        <AgentIdenticon seed={subject} size={size} glow={glow} crystallize={crystallize} />
      </AvatarFallback>
    </Avatar>
  );
}
