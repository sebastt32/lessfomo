export const MIN_PASSWORD_LENGTH = 12;

/** At least 12 characters (code points, so an emoji counts once). */
export const isStrongEnoughPassword = (password: string): boolean => [...password].length >= MIN_PASSWORD_LENGTH;
