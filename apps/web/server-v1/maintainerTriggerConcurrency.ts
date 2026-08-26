import { getAmaProjectId } from "./amaOwnerIntegrationRepo";
import { isAmaTaskDispatchConfigured, updateAmaHttpAgentTrigger } from "./amaRuntime";
import {
  type BoardMaintainer,
  listUnserializedBoardMaintainers,
  markBoardMaintainerHttpTriggerSerializationAttempted,
  markBoardMaintainerHttpTriggerSerialized,
} from "./boardMaintainerRepo";
import type { D1 } from "./db";
import { createLogger } from "./logger";
import type { Env } from "./types";

const logger = createLogger("maintainerTriggerConcurrency");

export async function ensureMaintainerHttpTriggerSerial(db: D1, env: Env, maintainer: BoardMaintainer): Promise<void> {
  if (maintainer.ama_http_trigger_serialized) return;
  if (!maintainer.ama_http_trigger_id) throw new Error(`Maintainer ${maintainer.id} has no AMA HTTP trigger`);
  const projectId = await getAmaProjectId(db, maintainer.owner_id);
  if (!projectId) throw new Error(`No AMA project for maintainer owner ${maintainer.owner_id}`);
  await updateAmaHttpAgentTrigger(env, maintainer.owner_id, projectId, maintainer.ama_http_trigger_id, { concurrency: "serial" });
  await markBoardMaintainerHttpTriggerSerialized(db, maintainer.owner_id, maintainer.board_id, maintainer.id);
}

export async function backfillMaintainerHttpTriggerConcurrency(db: D1, env: Env, limit = 25): Promise<number> {
  if (!isAmaTaskDispatchConfigured(env)) return 0;
  const maintainers = await listUnserializedBoardMaintainers(db, limit);
  let completed = 0;
  for (const maintainer of maintainers) {
    try {
      await ensureMaintainerHttpTriggerSerial(db, env, maintainer);
      completed += 1;
    } catch (error) {
      await markBoardMaintainerHttpTriggerSerializationAttempted(db, maintainer.owner_id, maintainer.board_id, maintainer.id);
      logger.warn(`failed to serialize maintainer ${maintainer.id}: ${error}`);
    }
  }
  return completed;
}
