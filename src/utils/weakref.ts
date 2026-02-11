/** Whether WeakRef is supported in this environment */
export const supportsWeakRef = typeof WeakRef !== "undefined";

/**
 * Type guard to check if a value can be used with WeakRef.
 * WeakRef only accepts objects (not primitives or null).
 */
export function isWeakRefCompatible(value: unknown): value is object {
	return (
		value !== null && (typeof value === "object" || typeof value === "function")
	);
}
