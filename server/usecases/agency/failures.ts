export type RealmrootDelegationFailureKind =
  | "user-login-required"
  | "authority-required"
  | "denied"
  | "reauthenticate"
  | "invalid-response"
  | "unavailable";

export class RealmrootDelegationFailure extends Error {
  constructor(
    readonly kind: RealmrootDelegationFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "RealmrootDelegationFailure";
  }
}

export class AgencySessionInvalidResponse extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgencySessionInvalidResponse";
  }
}
