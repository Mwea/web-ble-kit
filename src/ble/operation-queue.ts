import { AbortError } from "../errors";

/**
 * Options for creating an operation queue.
 */
export interface OperationQueueOptions {
	/**
	 * Maximum number of concurrent operations per characteristic.
	 * @default 1
	 */
	maxConcurrent?: number;
	/**
	 * AbortSignal to cancel all pending operations.
	 */
	signal?: AbortSignal;
}

/**
 * A per-characteristic operation queue that ensures BLE operations
 * are serialized to prevent GATT errors from concurrent access.
 *
 * The Web Bluetooth API does not support concurrent operations on the
 * same characteristic. This queue ensures operations are executed
 * sequentially per characteristic UUID.
 *
 * @example Preventing concurrent access to a characteristic
 * ```typescript
 * const queue = createOperationQueue();
 *
 * // These operations run sequentially, not concurrently
 * const results = await Promise.all([
 *   queue.enqueue(char.uuid, () => char.readValue()),
 *   queue.enqueue(char.uuid, () => char.writeValueWithResponse(data)),
 *   queue.enqueue(char.uuid, () => char.readValue()),
 * ]);
 * ```
 *
 * @example Device manager with shared queue
 * ```typescript
 * class DeviceManager {
 *   private queue = createOperationQueue();
 *
 *   async readBattery(char: BLEGATTCharacteristic) {
 *     return this.queue.enqueue(char.uuid, () => readWithTimeout(char));
 *   }
 *
 *   async sendCommand(char: BLEGATTCharacteristic, cmd: Uint8Array) {
 *     return this.queue.enqueue(char.uuid, () => writeWithTimeout(char, cmd));
 *   }
 * }
 * ```
 */
export interface OperationQueue {
	/**
	 * Enqueues an operation for a specific characteristic.
	 * The operation will be executed when all previous operations
	 * for the same characteristic have completed.
	 *
	 * @param characteristicUuid - The UUID of the characteristic
	 * @param operation - The async operation to execute
	 * @returns Promise resolving to the operation result
	 * @throws AbortError if the queue's signal is aborted
	 */
	enqueue<T>(
		characteristicUuid: string,
		operation: () => Promise<T>,
	): Promise<T>;

	/**
	 * Returns the number of pending operations for a characteristic.
	 * @param characteristicUuid - The UUID of the characteristic
	 * @returns Number of pending operations (0 if no queue exists)
	 */
	getQueueDepth(characteristicUuid: string): number;

	/**
	 * Clears all pending operations.
	 * Operations currently executing will complete, but queued operations
	 * will be rejected with AbortError.
	 */
	clear(): void;
}

/**
 * Creates a per-characteristic operation queue for serializing BLE operations.
 *
 * @example Basic usage
 * ```typescript
 * const queue = createOperationQueue();
 *
 * // Operations on the same characteristic are serialized
 * const [result1, result2] = await Promise.all([
 *   queue.enqueue('char-uuid', () => readWithTimeout(char)),
 *   queue.enqueue('char-uuid', () => writeWithTimeout(char, data)),
 * ]);
 * ```
 *
 * @example With abort signal
 * ```typescript
 * const controller = new AbortController();
 * const queue = createOperationQueue({ signal: controller.signal });
 *
 * // Cancel all pending operations
 * controller.abort();
 * ```
 *
 * @param options - Queue configuration options
 * @returns An OperationQueue instance
 */
export function createOperationQueue(
	options: OperationQueueOptions = {},
): OperationQueue {
	const { signal } = options;

	// Promise chain per characteristic - acts as a mutex
	const queues = new Map<string, Promise<void>>();
	// Track queue depth per characteristic
	const queueDepths = new Map<string, number>();
	// Track if the queue has been cleared
	let cleared = false;

	function enqueue<T>(
		characteristicUuid: string,
		operation: () => Promise<T>,
	): Promise<T> {
		// Check abort before queueing
		if (signal?.aborted) {
			return Promise.reject(
				new AbortError(signal.reason?.message ?? "Operation aborted"),
			);
		}

		if (cleared) {
			return Promise.reject(new AbortError("Queue has been cleared"));
		}

		// Increment queue depth
		const currentDepth = queueDepths.get(characteristicUuid) ?? 0;
		queueDepths.set(characteristicUuid, currentDepth + 1);

		// Get the current queue tail for this characteristic
		const currentQueue = queues.get(characteristicUuid) ?? Promise.resolve();

		// Create a deferred promise for the operation result
		let resolveOp: (value: T) => void;
		let rejectOp: (error: Error) => void;
		const resultPromise = new Promise<T>((resolve, reject) => {
			resolveOp = resolve;
			rejectOp = reject;
		});

		// Chain the new operation onto the queue
		const newQueue = currentQueue
			.then(async () => {
				// Check abort before executing
				if (signal?.aborted) {
					throw new AbortError(signal.reason?.message ?? "Operation aborted");
				}

				if (cleared) {
					throw new AbortError("Queue has been cleared");
				}

				return operation();
			})
			.then((result) => {
				resolveOp?.(result);
			})
			.catch((error: unknown) => {
				const err = error instanceof Error ? error : new Error(String(error));
				rejectOp?.(err);
			})
			.finally(() => {
				// Decrement queue depth
				const depth = queueDepths.get(characteristicUuid) ?? 1;
				if (depth <= 1) {
					queueDepths.delete(characteristicUuid);
					// Clean up empty queue
					if (queues.get(characteristicUuid) === newQueue) {
						queues.delete(characteristicUuid);
					}
				} else {
					queueDepths.set(characteristicUuid, depth - 1);
				}
			});

		queues.set(characteristicUuid, newQueue);

		// Set up abort handler
		if (signal && !signal.aborted) {
			const abortHandler = () => {
				rejectOp?.(
					new AbortError(signal.reason?.message ?? "Operation aborted"),
				);
			};
			signal.addEventListener("abort", abortHandler, { once: true });

			// Clean up abort handler when operation completes.
			// The .catch() prevents unhandled rejection warnings - errors are
			// already handled in the main promise chain above.
			resultPromise
				.finally(() => {
					signal.removeEventListener("abort", abortHandler);
				})
				.catch(() => {});
		}

		return resultPromise;
	}

	function getQueueDepth(characteristicUuid: string): number {
		return queueDepths.get(characteristicUuid) ?? 0;
	}

	function clear(): void {
		cleared = true;
		queues.clear();
		queueDepths.clear();
	}

	return {
		enqueue,
		getQueueDepth,
		clear,
	};
}
