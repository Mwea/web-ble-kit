export type EventMap = { [key: string]: unknown };

/**
 * An EventTarget with explicit cleanup capabilities.
 * Use dispose() to clean up all internal state and unsubscribe from the underlying emitter.
 */
export interface CleanableEventTarget extends EventTarget {
	/**
	 * Disposes of all internal resources, unsubscribes from the emitter,
	 * and clears all tracked listeners. After calling dispose(), the target
	 * should not be used.
	 */
	dispose(): void;
}

/**
 * A type-safe event emitter that provides compile-time checking for event names and payloads.
 *
 * @example Define typed events and create emitter
 * ```typescript
 * interface DeviceEvents {
 *   connect: { deviceId: string };
 *   disconnect: { reason: string };
 *   data: ArrayBuffer;
 * }
 *
 * const emitter = createEventEmitter<DeviceEvents>();
 *
 * // Type-safe: TypeScript knows 'connect' payload has deviceId
 * emitter.on('connect', ({ deviceId }) => {
 *   console.log('Connected to', deviceId);
 * });
 *
 * // Emit events with correct payload types
 * emitter.emit('connect', { deviceId: 'device-123' });
 * ```
 *
 * @example Unsubscribe from events
 * ```typescript
 * const unsubscribe = emitter.on('data', (buffer) => {
 *   processData(buffer);
 * });
 *
 * // Later, to stop listening:
 * unsubscribe();
 * ```
 *
 * @example One-time listeners
 * ```typescript
 * emitter.once('disconnect', ({ reason }) => {
 *   console.log('Disconnected:', reason);
 *   // This listener is automatically removed after first call
 * });
 * ```
 */
export interface TypedEventEmitter<T extends EventMap> {
	on<K extends keyof T>(event: K, callback: (data: T[K]) => void): () => void;
	once<K extends keyof T>(event: K, callback: (data: T[K]) => void): () => void;
	off<K extends keyof T>(event: K, callback: (data: T[K]) => void): void;
	removeAllListeners<K extends keyof T>(event?: K): void;
	emit<K extends keyof T>(event: K, data: T[K]): void;
	listenerCount<K extends keyof T>(event: K): number;
}

export function createEventEmitter<T extends EventMap>(): TypedEventEmitter<T> {
	const listeners = new Map<keyof T, Set<(data: unknown) => void>>();
	const onceWrappers = new Map<
		(data: unknown) => void,
		(data: unknown) => void
	>();

	function getListenerSet<K extends keyof T>(
		event: K,
	): Set<(data: unknown) => void> {
		let set = listeners.get(event);
		if (!set) {
			set = new Set();
			listeners.set(event, set);
		}
		return set;
	}

	function on<K extends keyof T>(
		event: K,
		callback: (data: T[K]) => void,
	): () => void {
		const set = getListenerSet(event);
		set.add(callback as (data: unknown) => void);
		return () => off(event, callback);
	}

	function once<K extends keyof T>(
		event: K,
		callback: (data: T[K]) => void,
	): () => void {
		const wrapper = ((data: T[K]) => {
			// Remove mapping when wrapper executes
			onceWrappers.delete(callback as (data: unknown) => void);
			off(event, wrapper as (data: T[K]) => void);
			callback(data);
		}) as (data: T[K]) => void;

		onceWrappers.set(
			callback as (data: unknown) => void,
			wrapper as (data: unknown) => void,
		);

		const set = getListenerSet(event);
		set.add(wrapper as (data: unknown) => void);
		return () => off(event, callback);
	}

	function off<K extends keyof T>(
		event: K,
		callback: (data: T[K]) => void,
	): void {
		const set = listeners.get(event);
		if (set) {
			const wrapper = onceWrappers.get(callback as (data: unknown) => void);
			if (wrapper) {
				set.delete(wrapper);
				onceWrappers.delete(callback as (data: unknown) => void);
			} else {
				set.delete(callback as (data: unknown) => void);
			}
		}
	}

	function removeAllListeners<K extends keyof T>(event?: K): void {
		if (event !== undefined) {
			const set = listeners.get(event);
			if (set) {
				for (const cb of set) {
					for (const [original, wrapper] of onceWrappers) {
						if (wrapper === cb) {
							onceWrappers.delete(original);
							break;
						}
					}
				}
			}
			listeners.delete(event);
		} else {
			listeners.clear();
			onceWrappers.clear();
		}
	}

	function emit<K extends keyof T>(event: K, data: T[K]): void {
		const set = listeners.get(event);
		if (set) {
			const callbacks = [...set];
			for (const cb of callbacks) {
				try {
					cb(data);
				} catch (err) {
					queueMicrotask(() => {
						console.error(
							"[web-ble-kit:event-emitter] Listener threw an error:",
							err,
						);
					});
				}
			}
		}
	}

	function listenerCount<K extends keyof T>(event: K): number {
		const set = listeners.get(event);
		return set ? set.size : 0;
	}

	return {
		on,
		once,
		off,
		removeAllListeners,
		emit,
		listenerCount,
	};
}

/**
 * Adapts a TypedEventEmitter to an EventTarget for browser integration.
 * Allows using addEventListener/removeEventListener with the emitter.
 * Properly tracks listener references and unsubscribes from emitter when
 * the last listener for an event type is removed.
 *
 * @returns A CleanableEventTarget that can be disposed to release all resources.
 */
export function toEventTarget<T extends EventMap>(
	emitter: TypedEventEmitter<T>,
): CleanableEventTarget {
	const target = new EventTarget();
	const subscriptions = new Map<keyof T, () => void>();
	// Track actual listener references per event type to handle deduplication correctly
	const trackedListeners = new Map<
		keyof T,
		Set<EventListenerOrEventListenerObject>
	>();
	const onceWrappers = new Map<
		EventListenerOrEventListenerObject,
		EventListener
	>();

	// Proxy addEventListener to subscribe to the emitter
	const originalAddEventListener = target.addEventListener.bind(target);
	const originalRemoveEventListener = target.removeEventListener.bind(target);

	/**
	 * Helper to remove a listener from our tracking and clean up emitter subscription
	 */
	function removeFromTracking(
		eventKey: keyof T,
		listener: EventListenerOrEventListenerObject,
	): void {
		const listeners = trackedListeners.get(eventKey);
		if (listeners?.has(listener)) {
			listeners.delete(listener);

			// Clean up once wrapper if exists
			onceWrappers.delete(listener);

			// Unsubscribe from emitter when last listener is removed
			if (listeners.size === 0) {
				const unsubscribe = subscriptions.get(eventKey);
				if (unsubscribe) {
					unsubscribe();
					subscriptions.delete(eventKey);
				}
				// Clean up empty Set to prevent memory leak
				trackedListeners.delete(eventKey);
			}
		}
	}

	target.addEventListener = (
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	) => {
		if (listener === null) {
			return; // EventTarget ignores null listeners
		}

		const eventKey = type as keyof T;
		const isOnce = typeof options === "object" && options?.once === true;

		let listeners = trackedListeners.get(eventKey);
		if (!listeners) {
			listeners = new Set();
			trackedListeners.set(eventKey, listeners);
		}

		// Check if this exact listener was already added (EventTarget deduplicates)
		const wasAlreadyAdded = listeners.has(listener);

		// Subscribe to emitter if this is the first listener for this event
		if (listeners.size === 0) {
			const unsubscribe = emitter.on(eventKey, (data) => {
				target.dispatchEvent(new CustomEvent(type, { detail: data }));
			});
			subscriptions.set(eventKey, unsubscribe);
		}

		// Only track if not already tracked (mirrors EventTarget deduplication)
		if (!wasAlreadyAdded) {
			listeners.add(listener);

			if (isOnce) {
				const wrappedListener: EventListener = (_e: Event) => {
					// Clean up our tracking AFTER the event fires
					// The native EventTarget removes the listener automatically,
					// but we need to update our tracking
					removeFromTracking(eventKey, listener);
				};
				onceWrappers.set(listener, wrappedListener);
				// Add the wrapper as a separate once listener to handle cleanup
				originalAddEventListener(type, wrappedListener, { once: true });
			}
		}

		originalAddEventListener(type, listener, options);
	};

	target.removeEventListener = (
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	) => {
		if (listener === null) {
			return;
		}

		const eventKey = type as keyof T;

		// Also remove the once wrapper if it exists
		const wrapper = onceWrappers.get(listener);
		if (wrapper) {
			originalRemoveEventListener(type, wrapper, options);
		}

		originalRemoveEventListener(type, listener, options);
		removeFromTracking(eventKey, listener);
	};

	/**
	 * Disposes of all internal resources and unsubscribes from the emitter.
	 */
	function dispose(): void {
		// Unsubscribe all emitter subscriptions
		for (const unsubscribe of subscriptions.values()) {
			unsubscribe();
		}
		subscriptions.clear();
		trackedListeners.clear();
		onceWrappers.clear();
	}

	// Return the target with dispose method attached
	return Object.assign(target, { dispose }) as CleanableEventTarget;
}
