import "vitest";

declare module "jest-axe" {
  export function axe(node: Element | DocumentFragment): Promise<{ violations: unknown[] }>;
  export function toHaveNoViolations(results: { violations: unknown[] }): {
    pass: boolean;
    message: () => string;
  };
}

declare module "vitest" {
  interface Assertion<T = any> {
    toHaveNoViolations(): T;
  }
}

export {};

