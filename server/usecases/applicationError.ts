export type ApplicationErrorKind = "invalid-request" | "not-found" | "conflict" | "invariant-failed";

export class ApplicationError extends Error {
  constructor(
    readonly kind: ApplicationErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}
