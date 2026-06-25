export class ReviewNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewNotFoundError";
  }
}

export class ReviewConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewConflictError";
  }
}

export class ReviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewValidationError";
  }
}
