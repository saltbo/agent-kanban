import { parseJsonFields } from "@server/db";
import type { Task } from "@shared";

type PersistedTaskFields = {
  active_claim_id?: string | null;
  creation_token?: string | null;
  result?: string | null;
  transition_token?: string | null;
};

export function mapTaskRow<T extends Task>(row: T & PersistedTaskFields): T {
  const task = parseJsonFields(row, ["labels", "input", "metadata"]) as T & PersistedTaskFields;
  delete task.active_claim_id;
  delete task.creation_token;
  delete task.result;
  delete task.transition_token;
  return task;
}
