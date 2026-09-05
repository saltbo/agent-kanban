import { createContext } from "react";
import type { AgentProfile } from "./agentProfileApi";

export const LocalAgentProfiles = createContext<Readonly<Record<string, AgentProfile>>>({});
