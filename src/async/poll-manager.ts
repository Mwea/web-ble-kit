import { isWeakRefCompatible, supportsWeakRef } from "../utils/weakref";

export interface PollManagerOptions {
	/** Default polling interval in milliseconds */
	defaultIntervalMs: number;
	/** Callback when a poll error occurs */
	onError: (error: Error) => void;
	/** Maximum consecutive errors before stopping polling */
	maxConsecutiveErrors?: number;
}

export interface PollStartOptions {
	/** Override the default polling interval */
	intervalMs?: number;
}

export interface PollManager<TContext> {
	start(context: TContext, options?: PollStartOptions): void;
	stop(): void;
	isPolling(): boolean;
}

/**
 * Creates a generic poll manager for periodic background operations.
 *
 * @param pollFn - The function to call on each poll. Receives the context.
 * @param options - Configuration options
 * @returns A poll manager instance
 *
 * @example Polling battery level from a BLE device
 * ```typescript
 * const batteryPoller = createPollManager<BLEConnectedSession>(
 *   async (session) => {
 *     const service = await session.getPrimaryService('battery_service');
 *     const char = await service.getCharacteristic('battery_level');
 *     const value = await char.readValue();
 *     console.log('Battery:', value.getUint8(0), '%');
 *   },
 *   {
 *     defaultIntervalMs: 30000, // Poll every 30 seconds
 *     onError: (err) => console.warn('Battery poll failed:', err.message),
 *     maxConsecutiveErrors: 3,
 *   }
 * );
 *
 * // Start polling when connected
 * batteryPoller.start(session);
 *
 * // Stop polling when disconnected
 * batteryPoller.stop();
 * ```
 *
 * @example Polling sensor data with custom interval
 * ```typescript
 * interface SensorContext {
 *   characteristic: BLEGATTCharacteristic;
 *   onData: (value: number) => void;
 * }
 *
 * const sensorPoller = createPollManager<SensorContext>(
 *   async (ctx) => {
 *     const data = await ctx.characteristic.readValue();
 *     ctx.onData(data.getUint16(0, true));
 *   },
 *   {
 *     defaultIntervalMs: 1000,
 *     onError: console.error,
 *   }
 * );
 *
 * // Start with faster polling rate
 * sensorPoller.start(context, { intervalMs: 100 });
 * ```
 */
export function createPollManager<TContext>(
	pollFn: (context: TContext) => Promise<void>,
	options: PollManagerOptions,
): PollManager<TContext> {
	const { defaultIntervalMs, onError, maxConsecutiveErrors = 3 } = options;

	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let sessionId = 0;

	function stop(): void {
		if (pollTimer !== null) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		sessionId = sessionId >= Number.MAX_SAFE_INTEGER ? 1 : sessionId + 1;
	}

	function start(context: TContext, startOptions: PollStartOptions = {}): void {
		stop();

		const intervalMs = startOptions.intervalMs ?? defaultIntervalMs;

		const currentSessionId = sessionId;

		// Use WeakRef for automatic cleanup: if the context is garbage collected
		// (e.g., session object no longer referenced), polling stops automatically.
		// Falls back to strong reference for primitives or environments without WeakRef.
		const contextRef =
			supportsWeakRef && isWeakRefCompatible(context)
				? new WeakRef(context)
				: { deref: () => context };

		let consecutiveErrors = 0;

		pollTimer = setInterval(() => {
			if (currentSessionId !== sessionId) {
				return;
			}

			const currentContext = contextRef.deref() as TContext | undefined;

			// Check specifically for undefined (GC'd WeakRef), not falsy values
			// This allows null, 0, '', false as valid contexts
			if (currentContext === undefined) {
				stop();
				return;
			}

			pollFn(currentContext)
				.then(() => {
					consecutiveErrors = 0;
				})
				.catch((e: unknown) => {
					consecutiveErrors++;
					onError(e instanceof Error ? e : new Error(String(e)));

					if (consecutiveErrors >= maxConsecutiveErrors) {
						console.warn(
							"[web-ble-kit:poll-manager] Too many consecutive errors, stopping polling",
						);
						stop();
					}
				});
		}, intervalMs);
	}

	function isPolling(): boolean {
		return pollTimer !== null;
	}

	return {
		start,
		stop,
		isPolling,
	};
}
