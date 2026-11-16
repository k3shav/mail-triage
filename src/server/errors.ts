/** An error whose code and message are safe to return to the browser. */
export class AppError extends Error {
  override name = 'AppError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
