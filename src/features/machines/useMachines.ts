import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface MachineProjection {
  id: string;
  name: string;
  description: string | null;
  status: "online" | "offline" | "draining" | "disabled";
  currentLoad: number;
  maxLoad: number;
  runnerCount: number;
  runtimes: Array<{ runtime: string; models: string[]; version?: string; state: string; detail?: string }>;
  lastHeartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MachineCreateResult {
  machine: MachineProjection;
  authCommand: string;
  startCommand: string;
}

export function useMachines() {
  return useQuery({ queryKey: ["machines"], queryFn: async () => (await api.machines.list()).items as MachineProjection[] });
}

export function useMachine(machineId: string | undefined) {
  return useQuery({
    queryKey: ["machines", machineId],
    queryFn: () => api.machines.get(machineId!) as Promise<MachineProjection>,
    enabled: Boolean(machineId),
  });
}

export function useCreateMachine() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ name, idempotencyKey }: { name: string; idempotencyKey: string }) =>
      api.machines.create(name, idempotencyKey) as Promise<MachineCreateResult>,
    onSuccess: () => client.invalidateQueries({ queryKey: ["machines"] }),
  });
}

export function useDeleteMachine() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.machines.delete(id), onSuccess: () => client.invalidateQueries({ queryKey: ["machines"] }) });
}
