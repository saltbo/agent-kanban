import type { D1 } from "@server/db";

export interface IdempotentHttpResponse {
  status: number;
  body: string;
  contentType: string;
  location: string;
  etag: string;
}

export interface ResourceIdempotency<T = unknown> {
  ownerId: string;
  actorId: string;
  apiVersion: string;
  key: string;
  method: string;
  path: string;
  requestHash: string;
  upstreamKey: string;
  resourceKind: string;
  responseFor?: (resource: T) => IdempotentHttpResponse;
}

export async function deleteExpiredIdempotencyRecords(db: D1): Promise<void> {
  await db.prepare("DELETE FROM resource_idempotency_records WHERE expires_at <= datetime('now')").run();
}

export function completeIdempotency<T>(db: D1, idempotency: ResourceIdempotency<T>, resourceId: string, resource: T): D1PreparedStatement {
  if (!idempotency.responseFor) throw new Error("Idempotent creation is missing its response snapshot factory");
  const response = idempotency.responseFor(resource);
  return db
    .prepare(
      `INSERT INTO resource_idempotency_records
         (owner_id, actor_id, api_version, idempotency_key, method, path,
          request_hash, resource_kind, resource_id, response_status, response_body,
          response_content_type, response_location, response_etag, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+24 hours'))`,
    )
    .bind(
      idempotency.ownerId,
      idempotency.actorId,
      idempotency.apiVersion,
      idempotency.key,
      idempotency.method,
      idempotency.path,
      idempotency.requestHash,
      idempotency.resourceKind,
      resourceId,
      response.status,
      response.body,
      response.contentType,
      response.location,
      response.etag,
    );
}

export async function resolveIdempotentResponse<T>(db: D1, idempotency: ResourceIdempotency<T>): Promise<IdempotentHttpResponse | null> {
  const record = await db
    .prepare(
      `SELECT method, path, request_hash, resource_kind, response_status,
              response_body, response_content_type, response_location, response_etag
       FROM resource_idempotency_records
       WHERE owner_id = ? AND actor_id = ? AND api_version = ?
         AND idempotency_key = ? AND expires_at > datetime('now')`,
    )
    .bind(idempotency.ownerId, idempotency.actorId, idempotency.apiVersion, idempotency.key)
    .first<{
      method: string;
      path: string;
      request_hash: string;
      resource_kind: string;
      response_status: number;
      response_body: string;
      response_content_type: string;
      response_location: string;
      response_etag: string;
    }>();
  if (!record) return null;
  if (
    record.method !== idempotency.method ||
    record.path !== idempotency.path ||
    record.request_hash !== idempotency.requestHash ||
    record.resource_kind !== idempotency.resourceKind
  ) {
    throw new ResourceIdempotencyConflict();
  }
  return {
    status: record.response_status,
    body: record.response_body,
    contentType: record.response_content_type,
    location: record.response_location,
    etag: record.response_etag,
  };
}

export class ResourceIdempotencyConflict extends Error {
  constructor() {
    super("Idempotency-Key was already used for a different request");
    this.name = "ResourceIdempotencyConflict";
  }
}

export class ResourceIdempotencyReplay extends Error {
  constructor(readonly response: IdempotentHttpResponse) {
    super("Idempotent request already completed");
    this.name = "ResourceIdempotencyReplay";
  }
}
