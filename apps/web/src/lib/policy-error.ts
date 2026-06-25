export const POLICY_FORBIDDEN_MESSAGE = "Forbidden";

export class PolicyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyViolationError";
  }
}
