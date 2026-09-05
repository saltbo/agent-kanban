import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type PageResponse } from "@/lib/api";

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

export interface MachineDetailProjection extends MachineProjection {
  runners: MachineRunnerProjection[];
  authCommand: string;
  startCommand: string;
}

export interface MachineRuntimeUsageWindow {
  label: string;
  utilization: number;
  resetsAt: string;
}

export interface MachineRunnerProjection {
  id: string;
  name: string;
  status: "active" | "offline" | "draining" | "disabled";
  currentLoad: number;
  maxLoad: number;
  runtimes: Array<{ runtime: string; models: string[]; version?: string; state: string; detail?: string }>;
  runtimeUsage: Array<{ runtime: string; windows: MachineRuntimeUsageWindow[] }>;
  lastHeartbeatAt: string | null;
}

export interface MachineCreateResult {
  machine: MachineProjection;
  authCommand: string;
  startCommand: string;
}

export interface MachinePageParams {
  pageSize?: number;
  pageToken?: string;
}

export function useMachines(params: MachinePageParams = {}) {
  return useQuery({ queryKey: ["machines", params], queryFn: async () => (await api.machines.list(params)) as PageResponse<MachineProjection> });
}

export function useMachine(machineId: string | undefined) {
  return useQuery({
    queryKey: ["machines", machineId],
    queryFn: () => api.machines.get(machineId!) as Promise<MachineDetailProjection>,
    enabled: Boolean(machineId),
  });
}

export function useCreateMachine() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey }: { idempotencyKey: string }) => api.machines.create(idempotencyKey) as Promise<MachineCreateResult>,
    onSuccess: () => client.invalidateQueries({ queryKey: ["machines"] }),
  });
}

export function useDeleteMachine() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.machines.delete(id), onSuccess: () => client.invalidateQueries({ queryKey: ["machines"] }) });
}
