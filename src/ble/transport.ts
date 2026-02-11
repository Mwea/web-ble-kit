import pRetry, { AbortError as PRetryAbortError } from "p-retry";
import {
	AbortError,
	isTransientBLEError,
	raceWithAbort,
	throwIfAborted,
	withTimeout,
} from "../errors/errors";
import type {
	BLEAdapter,
	BLEConnectedSession,
	BLEConnectOptions,
	BLEGATTCharacteristic,
} from "../types";
import { extractArrayBuffer } from "../utils/buffer";

/**
 * Options for BLE write operations.
 */
export interface WriteOptions {
	/** Timeout for the write operation in milliseconds */
	timeoutMs?: number;
	/** AbortSignal to cancel the write operation */
	signal?: AbortSignal;
}

/**
 * Options for BLE read operations.
 */
export interface ReadOptions {
	/** Timeout for the read operation in milliseconds */
	timeoutMs?: number;
	/** AbortSignal to cancel the read operation */
	signal?: AbortSignal;
}

/** Default timeout for BLE write operations in milliseconds */
export const DEFAULT_WRITE_TIMEOUT_MS = 10000;

/** Default timeout for starting BLE notifications in milliseconds */
export const DEFAULT_NOTIFICATION_TIMEOUT_MS = 15000;

/**
 * Gets the byte length of a buffer-like object.
 * All buffer-like types (ArrayBuffer, Uint8Array, DataView) share the byteLength property.
 */
function getByteLength(data: ArrayBuffer | Uint8Array | DataView): number {
	return data.byteLength;
}

/**
 * Writes data to a characteristic with a timeout and optional abort support.
 * BLE writes can hang indefinitely, so all user-facing write operations
 * should use this to prevent the app from becoming unresponsive.
 *
 * @warning **Non-cancellable Operation**: The abort signal or timeout will reject
 * the promise early, but the underlying BLE write continues in the background.
 * The device may still receive and process the data. This is a fundamental
 * limitation of the Web Bluetooth API - operations cannot be truly cancelled.
 * Verify device state after timeouts before retrying.
 *
 * @param char - The characteristic to write to
 * @param data - The data to write
 * @param options - Timeout and signal options (or just timeout in ms for backwards compatibility)
 * @throws Error if data is empty
 * @throws AbortError if the signal is aborted
 * @throws TimeoutError if the operation times out
 */
export async function writeWithTimeout(
	char: BLEGATTCharacteristic,
	data: ArrayBuffer | Uint8Array | DataView,
	options: WriteOptions | number = DEFAULT_WRITE_TIMEOUT_MS,
): Promise<void> {
	const opts: WriteOptions =
		typeof options === "number" ? { timeoutMs: options } : options;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
	const signal = opts.signal;

	throwIfAborted(signal);

	if (getByteLength(data) === 0) {
		throw new Error(
			"Empty data: cannot write zero bytes to BLE characteristic",
		);
	}

	const writePromise = withTimeout(
		char.writeValueWithResponse(data),
		timeoutMs,
		"BLE write",
	);
	await raceWithAbort(writePromise, signal);
}

/** Default timeout for BLE read operations in milliseconds */
export const DEFAULT_READ_TIMEOUT_MS = 5000;

/**
 * Reads the current value from a characteristic with a timeout and optional abort support.
 * BLE reads can hang indefinitely, so all user-facing read operations
 * should use this to prevent the app from becoming unresponsive.
 *
 * @warning **Non-cancellable Operation**: The abort signal or timeout will reject
 * the promise early, but the underlying BLE read continues in the background.
 * This is a fundamental limitation of the Web Bluetooth API.
 *
 * @param char - The characteristic to read from
 * @param options - Timeout and signal options (or just timeout in ms for backwards compatibility)
 * @returns Promise resolving to the characteristic value
 * @throws AbortError if the signal is aborted
 * @throws TimeoutError if the read takes too long
 */
export async function readWithTimeout(
	char: BLEGATTCharacteristic,
	options: ReadOptions | number = DEFAULT_READ_TIMEOUT_MS,
): Promise<DataView> {
	const opts: ReadOptions =
		typeof options === "number" ? { timeoutMs: options } : options;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
	const signal = opts.signal;

	throwIfAborted(signal);

	const readPromise = withTimeout(char.readValue(), timeoutMs, "BLE read");
	return raceWithAbort(readPromise, signal);
}

/**
 * Options for starting notifications.
 */
export interface StartNotificationsOptions {
	/** Timeout for starting notifications in milliseconds */
	timeoutMs?: number;
	/** Log prefix for warning messages */
	logPrefix?: string;
	/** AbortSignal to cancel the notification setup */
	signal?: AbortSignal;
}

/**
 * Starts notifications on a characteristic with timeout protection.
 * Returns a cleanup function to stop notifications and remove listeners.
 *
 * @warning **Non-cancellable Setup**: The abort signal or timeout will reject
 * the promise early, but the underlying notification setup may still complete.
 * This is a fundamental limitation of the Web Bluetooth API.
 *
 * @param char - The characteristic to start notifications on
 * @param onData - Callback invoked when data is received
 * @param options - Options including timeout, logger, and signal
 * @throws TimeoutError if notification setup takes too long
 * @throws AbortError if the signal is aborted
 *
 * @example Basic notification handling
 * ```typescript
 * const char = await service.getCharacteristic('heart_rate_measurement');
 *
 * const stopNotifications = await startNotifications(char, (data) => {
 *   const heartRate = new Uint8Array(data)[1];
 *   console.log('Heart rate:', heartRate, 'bpm');
 * });
 *
 * // Later, when done:
 * stopNotifications();
 * ```
 *
 * @example With abort signal for cleanup on disconnect
 * ```typescript
 * const controller = new AbortController();
 *
 * session.onDisconnect(() => controller.abort());
 *
 * const stop = await startNotifications(
 *   char,
 *   (data) => processData(data),
 *   { signal: controller.signal, timeoutMs: 5000 }
 * );
 * ```
 */
export async function startNotifications(
	char: BLEGATTCharacteristic,
	onData: (data: ArrayBuffer) => void,
	options: StartNotificationsOptions | number = {},
): Promise<() => void> {
	// Support legacy signature: startNotifications(char, onData, timeoutMs)
	const opts = typeof options === "number" ? { timeoutMs: options } : options;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_NOTIFICATION_TIMEOUT_MS;
	const logPrefix = opts.logPrefix ?? "[web-ble-kit]";
	const signal = opts.signal;

	throwIfAborted(signal);

	const listener = (ev: Event): void => {
		const ch = ev.target as unknown as BLEGATTCharacteristic;
		const ab = extractArrayBuffer(ch.value);
		if (ab) {
			onData(ab);
		}
	};

	const setupPromise = withTimeout(
		char.startNotifications(),
		timeoutMs,
		"BLE notification setup",
	);
	await raceWithAbort(setupPromise, signal);

	char.addEventListener("characteristicvaluechanged", listener);

	// Fix F-020: Make cleanup idempotent to prevent double-stop issues
	let cleaned = false;
	return () => {
		if (cleaned) return;
		cleaned = true;

		char.removeEventListener("characteristicvaluechanged", listener);
		char.stopNotifications().catch((e: unknown) => {
			console.warn(
				`${logPrefix} Error stopping notifications:`,
				e instanceof Error ? e.message : String(e),
			);
		});
	};
}

/**
 * Options for configuring retry behavior with exponential backoff.
 */
export interface RetryOptions {
	/** Maximum number of retry attempts (default: 3) */
	maxAttempts?: number;
	/** Initial delay in ms (default: 1000) */
	initialDelayMs?: number;
	/** Maximum delay in ms (default: 30000) */
	maxDelayMs?: number;
	/** Multiplier for exponential backoff (default: 2) */
	backoffMultiplier?: number;
	/** Add random jitter to prevent thundering herd (default: true) */
	jitter?: boolean;
	/** AbortSignal to cancel retries */
	signal?: AbortSignal;
	/** Called before each retry with attempt number and delay */
	onRetry?: (attempt: number, delayMs: number, error: Error) => void;
	/** Predicate to determine if error is retryable (default: isTransientBLEError) */
	isRetryable?: (error: Error) => boolean;
}

/**
 * Executes an operation with automatic retry and exponential backoff.
 * Uses p-retry under the hood.
 *
 * @example Basic usage
 * ```typescript
 * const result = await withRetry(() => riskyOperation(), {
 *   maxAttempts: 5,
 *   initialDelayMs: 500,
 * });
 * ```
 *
 * @example With abort support
 * ```typescript
 * const controller = new AbortController();
 * setTimeout(() => controller.abort(), 10000);
 *
 * const result = await withRetry(() => bleOperation(), {
 *   signal: controller.signal,
 *   onRetry: (attempt, delay, error) => {
 *     console.log(`Retry ${attempt} after ${delay}ms: ${error.message}`);
 *   },
 * });
 * ```
 *
 * @param operation - The async operation to execute
 * @param options - Retry configuration options
 * @returns Promise resolving to the operation result
 * @throws The last error if all retries fail, or AbortError if cancelled
 */
export async function withRetry<T>(
	operation: () => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	const {
		maxAttempts = 3,
		initialDelayMs = 1000,
		maxDelayMs = 30000,
		backoffMultiplier = 2,
		jitter = true,
		signal,
		onRetry,
		isRetryable = isTransientBLEError,
	} = options;

	if (maxAttempts < 1) {
		throw new RangeError(`maxAttempts must be >= 1, got ${maxAttempts}`);
	}

	// Fail fast if already aborted
	if (signal?.aborted) {
		throw new AbortError(signal.reason?.message ?? "Operation aborted");
	}

	// Ensure initialDelayMs doesn't exceed maxDelayMs (p-retry requires minTimeout <= maxTimeout)
	const effectiveInitialDelay = Math.min(initialDelayMs, maxDelayMs);

	try {
		return await pRetry(
			async () => {
				try {
					return await operation();
				} catch (e) {
					const error = e instanceof Error ? e : new Error(String(e));

					// If not retryable, throw p-retry's AbortError to stop retrying
					if (!isRetryable(error)) {
						throw new PRetryAbortError(error.message);
					}

					throw error;
				}
			},
			{
				// p-retry uses retries (extra attempts after first), we use maxAttempts (total)
				retries: maxAttempts - 1,
				minTimeout: effectiveInitialDelay,
				maxTimeout: maxDelayMs,
				factor: backoffMultiplier,
				randomize: jitter,
				...(signal && { signal }),
				onFailedAttempt: (error) => {
					// Only call onRetry if there are retries left
					if (error.retriesLeft > 0 && onRetry) {
						// Calculate what the delay will be (approximate, p-retry handles actual timing)
						const attempt = error.attemptNumber;
						const delayMs = Math.min(
							effectiveInitialDelay * backoffMultiplier ** (attempt - 1),
							maxDelayMs,
						);
						onRetry(attempt, delayMs, error);
					}
				},
			},
		);
	} catch (e) {
		// Convert p-retry's AbortError back to our AbortError for signal aborts
		if (e instanceof Error && e.name === "AbortError" && signal?.aborted) {
			throw new AbortError(signal.reason?.message ?? "Operation aborted");
		}
		throw e;
	}
}

/**
 * Options for BLE operations with retry support.
 */
export interface BLERetryOptions extends RetryOptions {
	/** Timeout for the BLE operation in ms */
	timeoutMs?: number;
}

/**
 * Reads from a BLE characteristic with automatic retry on transient failures.
 *
 * @example
 * ```typescript
 * const value = await readWithRetry(characteristic, {
 *   maxAttempts: 3,
 *   timeoutMs: 5000,
 * });
 * ```
 *
 * @param char - The characteristic to read from
 * @param options - Retry and timeout options
 * @returns Promise resolving to the characteristic value
 */
export async function readWithRetry(
	char: BLEGATTCharacteristic,
	options: BLERetryOptions = {},
): Promise<DataView> {
	const { timeoutMs = DEFAULT_READ_TIMEOUT_MS, ...retryOptions } = options;

	return withRetry(() => readWithTimeout(char, timeoutMs), retryOptions);
}

/**
 * Writes to a BLE characteristic with automatic retry on transient failures.
 *
 * @example
 * ```typescript
 * await writeWithRetry(characteristic, new Uint8Array([0x01, 0x02]), {
 *   maxAttempts: 3,
 *   timeoutMs: 10000,
 * });
 * ```
 *
 * @param char - The characteristic to write to
 * @param data - The data to write
 * @param options - Retry and timeout options
 */
export async function writeWithRetry(
	char: BLEGATTCharacteristic,
	data: BufferSource,
	options: BLERetryOptions = {},
): Promise<void> {
	const { timeoutMs = DEFAULT_WRITE_TIMEOUT_MS, ...retryOptions } = options;

	return withRetry(
		() =>
			writeWithTimeout(
				char,
				data as ArrayBuffer | Uint8Array | DataView,
				timeoutMs,
			),
		retryOptions,
	);
}

/**
 * Connects to a BLE device with automatic retry on transient failures.
 *
 * @example
 * ```typescript
 * const session = await connectWithRetry(adapter, {
 *   filters: [{ namePrefix: 'MyDevice' }],
 * }, {
 *   maxAttempts: 3,
 *   onRetry: (attempt, delay, error) => {
 *     console.log(`Connection attempt ${attempt} failed, retrying in ${delay}ms`);
 *   },
 * });
 * ```
 *
 * @param adapter - The BLE adapter to use
 * @param connectOptions - Options for the connection
 * @param retryOptions - Retry configuration
 * @returns Promise resolving to the connected session
 */
export async function connectWithRetry(
	adapter: BLEAdapter,
	connectOptions: BLEConnectOptions = {},
	retryOptions: RetryOptions = {},
): Promise<BLEConnectedSession> {
	// Pass the abort signal to both retry logic and connect options
	const signal = retryOptions.signal ?? connectOptions.signal;

	// Build connect options, only include signal if defined
	const finalConnectOptions: BLEConnectOptions = { ...connectOptions };
	if (signal) {
		finalConnectOptions.signal = signal;
	}

	// Build retry options, only include signal if defined
	const finalRetryOptions: RetryOptions = { ...retryOptions };
	if (signal) {
		finalRetryOptions.signal = signal;
	}

	return withRetry(
		() => adapter.connect(finalConnectOptions),
		finalRetryOptions,
	);
}
