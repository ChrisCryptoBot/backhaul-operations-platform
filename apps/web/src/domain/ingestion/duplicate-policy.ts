export interface DuplicatePolicyInput {
  hasExactHashDuplicate: boolean;
  hasSoftDuplicate: boolean;
}

export type DuplicateResolution =
  | { kind: "ACCEPT_NEW" }
  | { kind: "EXACT_DUPLICATE" }
  | { kind: "SOFT_DUPLICATE_WARNING" };

export function evaluateDuplicatePolicy(input: DuplicatePolicyInput): DuplicateResolution {
  if (input.hasExactHashDuplicate) {
    return { kind: "EXACT_DUPLICATE" };
  }
  if (input.hasSoftDuplicate) {
    return { kind: "SOFT_DUPLICATE_WARNING" };
  }
  return { kind: "ACCEPT_NEW" };
}

