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
