import { createWebBluetoothAdapter } from "../adapter";
import { createEventEmitter, type TypedEventEmitter } from "../state";
import type {
	BLEAdapter,
	BLEConnectedSession,
	BLEConnectOptions,
} from "../types";
import { connectWithRetry, type RetryOptions } from "./transport";

/**
 * Maximum concurrent BLE connections per Bluetooth adapter.
 * This is a hardware/spec limitation, not software.
 */
export const MAX_BLE_CONNECTIONS = 7;

/**
 * Events emitted by the connection pool.
 */
export interface ConnectionPoolEvents extends Record<string, unknown> {
	/** Fired when a device connects */
	connect: { deviceId: string; session: BLEConnectedSession };
	/** Fired when a device disconnects */
	disconnect: { deviceId: string };
}

/**
 * Options for creating a connection pool.
 */
export interface ConnectionPoolOptions {
	/**
	 * Maximum concurrent connections.
	 * @default 7 (BLE spec limit)
	 */
	maxConnections?: number;

	/**
	 * Factory function to create adapters for each device.
	 * Defaults to createWebBluetoothAdapter().
	 */
	createAdapter?: () => BLEAdapter;

	/**
	 * Enable automatic reconnection on unexpected disconnect.
	 * @default false
	 */
	autoReconnect?: boolean;

	/**
	 * Retry options for auto-reconnect attempts.
	 */
	reconnectOptions?: RetryOptions;
}

/**
 * Manages multiple concurrent BLE connections.
 *
 * The pool tracks connected devices and provides a unified interface
 * for managing multiple simultaneous BLE connections.
 */
export interface ConnectionPool {
	/**
	 * Connect to a new device.
	 * Shows the browser's device picker dialog.
	 *
	 * @param options - Connection options including filters
	 * @returns Promise resolving to the connected session
	 * @throws Error if max connections reached or connection fails
	 */
	connect(options?: BLEConnectOptions): Promise<BLEConnectedSession>;

	/**
	 * Get an existing session by device ID.
	 *
	 * @param deviceId - The device ID to look up
	 * @returns The session if connected, null otherwise
	 */
	getSession(deviceId: string): BLEConnectedSession | null;

	/**
	 * Check if a device is currently connected.
	 *
	 * @param deviceId - The device ID to check
	 * @returns True if the device is connected
	 */
	isConnected(deviceId: string): boolean;

	/**
	 * Disconnect a specific device.
	 *
	 * @param deviceId - The device ID to disconnect
	 */
	disconnect(deviceId: string): Promise<void>;

	/**
	 * Disconnect all connected devices.
	 */
	disconnectAll(): Promise<void>;

	/**
	 * Get all active sessions.
	 *
	 * @returns Map of device IDs to sessions
	 */
	getSessions(): Map<string, BLEConnectedSession>;

	/**
	 * Get the number of active connections.
	 */
	readonly connectionCount: number;

	/**
	 * Get the maximum allowed connections.
	 */
	readonly maxConnections: number;

	/**
	 * Register a callback for device connection events.
	 *
	 * @param callback - Called when a device connects
	 * @returns Unsubscribe function
	 */
	onConnect(
		callback: (deviceId: string, session: BLEConnectedSession) => void,
	): () => void;

	/**
	 * Register a callback for device disconnection events.
	 *
	 * @param callback - Called when a device disconnects
	 * @returns Unsubscribe function
	 */
	onDisconnect(callback: (deviceId: string) => void): () => void;
}

/**
 * Creates a connection pool for managing multiple BLE device connections.
 *
 * @example Basic usage
 * ```typescript
 * const pool = createConnectionPool();
 *
 * // Connect to multiple devices
 * const session1 = await pool.connect({ filters: [{ namePrefix: 'Device1' }] });
 * const session2 = await pool.connect({ filters: [{ namePrefix: 'Device2' }] });
 *
 * // Check connection status
 * console.log('Connected devices:', pool.connectionCount);
 *
 * // Disconnect all
 * await pool.disconnectAll();
 * ```
 *
 * @example With auto-reconnect
 * ```typescript
 * const pool = createConnectionPool({
 *   autoReconnect: true,
 *   reconnectOptions: {
 *     maxAttempts: 5,
 *     onRetry: (attempt, delay) => {
 *       console.log(`Reconnect attempt ${attempt} in ${delay}ms`);
 *     },
 *   },
 * });
 *
 * pool.onDisconnect((deviceId) => {
 *   console.log(`Device ${deviceId} disconnected`);
 * });
 * ```
 *
 * @param options - Pool configuration options
 * @returns A connection pool instance
 */
export function createConnectionPool(
	options: ConnectionPoolOptions = {},
): ConnectionPool {
	const {
		maxConnections = MAX_BLE_CONNECTIONS,
		createAdapter = () => createWebBluetoothAdapter(),
		autoReconnect = false,
		reconnectOptions = {},
	} = options;

	const sessions = new Map<string, BLEConnectedSession>();
	const adapters = new Map<string, BLEAdapter>();
	const disconnectCleanups = new Map<string, () => void>();
	const emitter: TypedEventEmitter<ConnectionPoolEvents> = createEventEmitter();
	// Fix F-018: Track devices currently attempting reconnection
	const reconnectingDevices = new Set<string>();
	// Fix M-001: Track pending connections to prevent race conditions
	let pendingConnections = 0;

	// Internal function to handle disconnect
	function handleDisconnect(deviceId: string): void {
		const session = sessions.get(deviceId);
		if (!session) return;

		// Clean up
		sessions.delete(deviceId);
		const cleanup = disconnectCleanups.get(deviceId);
		if (cleanup) {
			cleanup();
			disconnectCleanups.delete(deviceId);
		}

		emitter.emit("disconnect", { deviceId });

		// Attempt auto-reconnect if enabled
		if (autoReconnect) {
			const adapter = adapters.get(deviceId);
			if (adapter?.reconnect) {
				reconnectDevice(deviceId, adapter).catch(() => {
					// Reconnect failed, adapter is cleaned up
					adapters.delete(deviceId);
				});
			}
		} else {
			// Clean up adapter if not auto-reconnecting
			adapters.delete(deviceId);
		}
	}

	// Internal function to attempt reconnection
	async function reconnectDevice(
		deviceId: string,
		adapter: BLEAdapter,
	): Promise<void> {
		if (!adapter.reconnect) return;

		// Mark as reconnecting
		reconnectingDevices.add(deviceId);

		try {
			const session = await connectWithRetry(
				{
					connect: async () => {
						const result = await adapter.reconnect?.();
						if (!result)
							throw new Error("No device available for reconnection");
						return result;
					},
				} as BLEAdapter,
				{},
				reconnectOptions,
			);

			if (!reconnectingDevices.has(deviceId)) {
				// User explicitly disconnected during reconnect, clean up the new session
				await session.disconnect().catch(() => {});
				return;
			}

			// Re-register the session
			sessions.set(deviceId, session);

			// Set up disconnect handler
			if (session.onDisconnect) {
				const cleanup = session.onDisconnect(() => handleDisconnect(deviceId));
				disconnectCleanups.set(deviceId, cleanup);
			}

			emitter.emit("connect", { deviceId, session });
		} catch (error) {
			console.warn(
				`[web-ble-kit:connection-pool] Reconnection failed for device ${deviceId}:`,
				error instanceof Error ? error.message : error,
			);
			adapters.delete(deviceId);
		} finally {
			reconnectingDevices.delete(deviceId);
		}
	}

	return {
		async connect(
			connectOptions: BLEConnectOptions = {},
		): Promise<BLEConnectedSession> {
			if (sessions.size + pendingConnections >= maxConnections) {
				throw new Error(
					`Maximum connections (${maxConnections}) reached. Disconnect a device before connecting another.`,
				);
			}

			pendingConnections++;
			try {
				const adapter = createAdapter();
				const session = await adapter.connect(connectOptions);
				const deviceId = session.deviceId;

				// Store adapter for potential reconnection
				adapters.set(deviceId, adapter);
				sessions.set(deviceId, session);

				// Set up disconnect handler
				if (session.onDisconnect) {
					const cleanup = session.onDisconnect(() =>
						handleDisconnect(deviceId),
					);
					disconnectCleanups.set(deviceId, cleanup);
				}

				emitter.emit("connect", { deviceId, session });

				return session;
			} finally {
				pendingConnections--;
			}
		},

		getSession(deviceId: string): BLEConnectedSession | null {
			return sessions.get(deviceId) ?? null;
		},

		isConnected(deviceId: string): boolean {
			return sessions.has(deviceId);
		},

		async disconnect(deviceId: string): Promise<void> {
			reconnectingDevices.delete(deviceId);

			const session = sessions.get(deviceId);
			if (!session) return;

			// Remove from sessions before disconnecting to prevent reconnect attempts
			sessions.delete(deviceId);
			adapters.delete(deviceId);

			const cleanup = disconnectCleanups.get(deviceId);
			if (cleanup) {
				cleanup();
				disconnectCleanups.delete(deviceId);
			}

			await session.disconnect();
			emitter.emit("disconnect", { deviceId });
		},

		async disconnectAll(): Promise<void> {
			const deviceIds = Array.from(sessions.keys());
			const results = await Promise.allSettled(
				deviceIds.map((id) => this.disconnect(id)),
			);
			const failures = results.filter((r) => r.status === "rejected");
			if (failures.length > 0) {
				console.warn(
					`[web-ble-kit:connection-pool] ${failures.length} disconnect(s) failed`,
				);
			}
		},

		getSessions(): Map<string, BLEConnectedSession> {
			return new Map(sessions);
		},

		get connectionCount(): number {
			return sessions.size;
		},

		get maxConnections(): number {
			return maxConnections;
		},

		onConnect(
			callback: (deviceId: string, session: BLEConnectedSession) => void,
		): () => void {
			return emitter.on("connect", ({ deviceId, session }) =>
				callback(deviceId, session),
			);
		},

		onDisconnect(callback: (deviceId: string) => void): () => void {
			return emitter.on("disconnect", ({ deviceId }) => callback(deviceId));
		},
	};
}
