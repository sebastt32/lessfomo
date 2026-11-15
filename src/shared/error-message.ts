/** The message of an Error, or the value itself as text. */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
