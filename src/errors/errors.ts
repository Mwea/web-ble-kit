/**
 * Custom error class for timeout operations.
 *
 * Note: The underlying BLE operation may still complete in the background
 * after a timeout is thrown. The Web Bluetooth API does not support true
 * operation cancellation.
 */
export class TimeoutError extends Error {
	constructor(
		public readonly operation: string,
		public readonly timeout: number,
	) {
		super(`${operation} timed out after ${timeout}ms`);
		this.name = "TimeoutError";
	}
}

/**
 * Error thrown when an operation is aborted via AbortSignal.
 */
export class AbortError extends Error {
	constructor(message = "Operation aborted") {
		super(message);
		this.name = "AbortError";
	}
}

/**
 * Throws an AbortError if the given signal is aborted.
 * Use this at the start of async operations to fail fast on abort.
 *
 * @example
 * ```typescript
 * async function myOperation(signal?: AbortSignal) {
 *   throwIfAborted(signal);
 *   // ... perform operation
 * }
 * ```
 *
 * @param signal - The AbortSignal to check
 * @throws {AbortError} If the signal is aborted
 */
export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		const reason = signal.reason;
		const message =
			reason instanceof Error
				? reason.message
				: typeof reason === "string"
					? reason
					: "Operation aborted";
		throw new AbortError(message);
	}
}

/**
 * Races a promise against an AbortSignal, rejecting with AbortError if aborted.
 *
 * Note: This does NOT cancel the underlying promise - it continues running
 * in the background. This is a fundamental limitation of JavaScript promises
 * and the Web Bluetooth API.
 *
 * @example
 * ```typescript
 * const controller = new AbortController();
 * setTimeout(() => controller.abort(), 5000);
 *
 * try {
 *   const result = await raceWithAbort(
 *     slowBleOperation(),
 *     controller.signal,
 *   );
 * } catch (e) {
 *   if (e instanceof AbortError) {
 *     console.log('Operation was aborted');
 *   }
 * }
 * ```
 *
 * @param promise - The promise to race
 * @param signal - The AbortSignal to race against
 * @returns Promise that resolves/rejects with the original promise, or rejects with AbortError
 */
export function raceWithAbort<T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return promise;

	return new Promise((resolve, reject) => {
		const abortHandler = () => {
			const reason = signal.reason;
			const message =
				reason instanceof Error
					? reason.message
					: typeof reason === "string"
						? reason
						: "Operation aborted";
			reject(new AbortError(message));
		};

		// Check if already aborted
		if (signal.aborted) {
			abortHandler();
			return;
		}

		signal.addEventListener("abort", abortHandler, { once: true });

		promise
			.then(resolve)
			.catch(reject)
			.finally(() => signal.removeEventListener("abort", abortHandler));
	});
}

/**
 * Error thrown when attempting an operation that requires a connection
 * but the device is not connected.
 */
export class NotConnectedError extends Error {
	constructor() {
		super("Not connected to device");
		this.name = "NotConnectedError";
	}
}

/**
 * Normalizes any thrown value into an Error instance.
 * Ensures consistent error handling throughout the codebase.
 */
export function normalizeError(e: unknown): Error {
	if (e instanceof Error) {
		return e;
	}

	if (e === null) {
		return new Error("null");
	}

	if (e === undefined) {
		return new Error("undefined");
	}

	if (typeof e === "string") {
		return new Error(e);
	}

	if (typeof e === "object") {
		try {
			return new Error(JSON.stringify(e));
		} catch {
			// Circular reference or other JSON error
			return new Error(String(e));
		}
	}

	return new Error(String(e));
}

/**
 * Wraps a promise with a timeout.
 * If the promise doesn't resolve/reject within the specified time,
 * rejects with a TimeoutError.
 *
 * **Important:** This does NOT cancel the underlying operation.
 * The original promise continues running in the background even after
 * timeout. For BLE operations, this means a write may still complete
 * after the timeout rejects. Callers should handle this if needed
 * (e.g., by checking connection state before processing results).
 *
 * @param promise - The promise to wrap with a timeout
 * @param ms - Timeout duration in milliseconds
 * @param label - Descriptive label for the operation (used in error message)
 * @returns A promise that rejects with TimeoutError if the timeout expires first
 * @throws {TimeoutError} If the operation times out
 */
export function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			reject(new TimeoutError(label, ms));
		}, ms);

		promise
			.then((value) => {
				clearTimeout(timeoutId);
				resolve(value);
			})
			.catch((error: unknown) => {
				clearTimeout(timeoutId);
				reject(error);
			});
	});
}

/**
 * Determines if a BLE error is transient and worth retrying.
 *
 * Retries on:
 * - Timeout errors
 * - Network errors
 * - GATT operation failed
 * - Connection/disconnect errors
 *
 * Does NOT retry on:
 * - User cancelled (AbortError)
 * - Device not found
 * - Security errors
 * - NotAllowedError (user denied permission)
 * - Unknown errors (fail-fast behavior for safety)
 *
 * @remarks
 * Unknown errors default to non-retryable (fail-fast) to prevent masking
 * unexpected issues. If you need to retry unknown errors, provide a custom
 * `isRetryable` predicate to `withRetry()`.
 */
export function isTransientBLEError(error: Error): boolean {
	// Never retry abort errors - user explicitly cancelled
	if (error instanceof AbortError || error.name === "AbortError") {
		return false;
	}

	// Timeout errors are retryable
	if (error instanceof TimeoutError || error.name === "TimeoutError") {
		return true;
	}

	const message = error.message.toLowerCase();
	const name = error.name.toLowerCase();

	// Don't retry user cancellation or permission errors
	const nonRetryablePatterns = [
		"user cancelled",
		"user canceled",
		"user denied",
		"notallowederror",
		"securityerror",
		"not found",
		"no device selected",
		"permission denied",
	];

	for (const pattern of nonRetryablePatterns) {
		if (message.includes(pattern) || name.includes(pattern)) {
			return false;
		}
	}

	// Retry network and GATT errors
	const retryablePatterns = [
		"network",
		"gatt",
		"connection",
		"disconnect",
		"failed to execute",
		"operation failed",
		"not connected",
	];

	for (const pattern of retryablePatterns) {
		if (message.includes(pattern) || name.includes(pattern)) {
			return true;
		}
	}

	// Default: do NOT retry unknown errors (fail-fast for safety)
	return false;
}
