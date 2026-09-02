export type AmaProjectionFailureKind = "not-found" | "denied" | "rejected" | "invalid-response" | "unavailable";

export class AmaProjectionError extends Error {
  constructor(
    readonly kind: AmaProjectionFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "AmaProjectionError";
  }
}

export type RealmrootDelegationFailureKind = "authority-required" | "denied" | "reauthenticate" | "invalid-response" | "unavailable";

export class RealmrootDelegationFailure extends Error {
  constructor(
    readonly kind: RealmrootDelegationFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "RealmrootDelegationFailure";
  }
}
