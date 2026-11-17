/** Injection token of the `UserStore` port. */
export const USER_STORE = Symbol("USER_STORE");
/** Injection token of the `SessionStore` port. */
export const SESSION_STORE = Symbol("SESSION_STORE");
/** Injection token of the `AuthService`. */
export const AUTH_SERVICE = Symbol("AUTH_SERVICE");
/** Injection token of the clock (`() => Date`) sessions and the sign-in limit are measured with. */
export const AUTH_CLOCK = Symbol("AUTH_CLOCK");
