/**
 * @fileoverview Core type definitions for web-ble-kit.
 *
 * ## Null vs Undefined Conventions
 *
 * This library follows consistent semantics for `null` and `undefined`:
 *
 * - **`null`**: Intentionally empty or "not found"
 *   - `storage.get()` returns `null` when no device ID is stored
 *   - `extractArrayBuffer()` returns `null` for invalid/empty buffers
 *   - `reconnect()` returns `null` when no cached device is available
 *
 * - **`undefined`**: Not set yet or optional property
 *   - `characteristic.value` is `undefined` before first read
 *   - Optional interface properties use `undefined` for unset values
 *   - Matches Web Bluetooth API behavior
 *
 * This distinction helps differentiate between "we checked and nothing is there"
 * (null) vs "we haven't checked yet" (undefined).
 */

/**
 * Connection lifecycle state.
 * - 'disconnected': No active connection
 * - 'connecting': Connection in progress
 * - 'connected': Successfully connected to device
 * - 'error': Connection failed (can retry via connect/reconnect)
 */
export type ConnectionState =
	| "disconnected"
	| "connecting"
	| "connected"
	| "error";

/**
 * Event data received when an advertisement is detected.
 *
 * Note: RSSI is only available while watching advertisements,
 * NOT while connected. This is a Web Bluetooth API limitation.
 */
export interface AdvertisementEvent {
	/** Received Signal Strength Indicator in dBm */
	rssi?: number;
	/** Device name from advertisement */
	name?: string;
	/** Transmit power level in dBm */
	txPower?: number;
	/** Manufacturer-specific data keyed by company ID */
	manufacturerData?: Map<number, DataView>;
	/** Service-specific data keyed by service UUID */
	serviceData?: Map<string, DataView>;
	/** Service UUIDs advertised by the device */
	uuids?: string[];
}

/**
 * Properties indicating what operations a characteristic supports.
 * Maps directly to the Web Bluetooth CharacteristicProperties interface.
 */
export interface CharacteristicProperties {
	/** Characteristic supports broadcasting */
	broadcast?: boolean;
	/** Characteristic supports reading */
	read?: boolean;
	/** Characteristic supports write without response (faster, no ACK) */
	writeWithoutResponse?: boolean;
	/** Characteristic supports write with response */
	write?: boolean;
	/** Characteristic supports notifications (passive value updates) */
	notify?: boolean;
	/** Characteristic supports indications (acknowledged notifications) */
	indicate?: boolean;
	/** Characteristic supports authenticated signed writes */
	authenticatedSignedWrites?: boolean;
	/** Characteristic supports reliable writes */
	reliableWrite?: boolean;
	/** Characteristic has writable auxiliaries */
	writableAuxiliaries?: boolean;
}

/**
 * Filter options for Bluetooth device discovery.
 */
export interface RequestDeviceFilter {
	/** Match devices whose name starts with this prefix */
	namePrefix?: string;
	/** Match devices with this exact name */
	name?: string;
	/** Match devices advertising these service UUIDs */
	services?: (number | string)[];
}

/**
 * Base options for connecting to a BLE device.
 */
export interface BLEConnectOptions {
	/**
	 * Bluetooth device filters.
	 */
	filters?: RequestDeviceFilter[];
	/**
	 * Optional service UUIDs to request access to.
	 */
	optionalServices?: (number | string)[];
	/**
	 * If true, stores device ID in storage for faster reconnection.
	 * @default false
	 */
	rememberDevice?: boolean;
	/**
	 * AbortSignal to cancel the connection attempt.
	 */
	signal?: AbortSignal;
}

/**
 * Represents an established BLE connection session.
 * Provides access to GATT services and connection lifecycle management.
 *
 * @remarks
 * Implementers should ensure that:
 * - `getPrimaryServices()` returns all available GATT services
 * - `disconnect()` cleanly terminates the connection
 * - `onDisconnect()` fires when the device disconnects unexpectedly
 *
 * @example Custom adapter implementation
 * ```typescript
 * const session: BLEConnectedSession = {
 *   deviceId: 'my-device-id',
 *   async getPrimaryServices() {
 *     return myDevice.getServices();
 *   },
 *   async disconnect() {
 *     await myDevice.disconnect();
 *   },
 *   onDisconnect(callback) {
 *     myDevice.on('disconnect', callback);
 *     return () => myDevice.off('disconnect', callback);
 *   }
 * };
 * ```
 */
export interface BLEConnectedSession {
	/** The unique identifier for the connected device */
	readonly deviceId: string;

	/** The human-readable name of the connected device, if available */
	readonly deviceName: string | undefined;

	/**
	 * Retrieves all primary GATT services from the connected device.
	 * @returns Promise resolving to an array of GATT services
	 */
	getPrimaryServices(): Promise<BLEGATTService[]>;

	/**
	 * Retrieves a specific primary GATT service by UUID.
	 * @param uuid - The service UUID to retrieve
	 * @returns Promise resolving to the GATT service
	 * @throws Error if service not found
	 */
	getPrimaryService(uuid: BluetoothServiceUUID): Promise<BLEGATTService>;

	/**
	 * Disconnects from the BLE device.
	 * Should be idempotent - safe to call multiple times.
	 */
	disconnect(): Promise<void>;

	/**
	 * Registers a callback for unexpected disconnection events.
	 * Called when the device disconnects unexpectedly (out of range, powered off, etc.).
	 * @param callback - Function to call when disconnection occurs
	 * @returns A function to unregister the callback
	 */
	onDisconnect?(callback: () => void): () => void;

	/**
	 * Start watching for advertisements from this device.
	 * This enables RSSI monitoring while the device remains in range.
	 *
	 * Note: This is the only way to get RSSI updates in Web Bluetooth.
	 * RSSI is NOT available through the regular connection.
	 *
	 * @throws Error if the browser doesn't support watchAdvertisements
	 */
	watchAdvertisements?(): Promise<void>;

	/**
	 * Stop watching for advertisements.
	 * Note: Web Bluetooth API doesn't have a direct unwatchAdvertisements method,
	 * so this removes our event listener but the browser may continue scanning.
	 */
	unwatchAdvertisements?(): void;

	/**
	 * Whether currently watching for advertisements.
	 */
	readonly watchingAdvertisements?: boolean | undefined;

	/**
	 * Last known RSSI value in dBm.
	 * Only available while watching advertisements.
	 */
	readonly rssi?: number | undefined;

	/**
	 * Register a callback for advertisement events.
	 * Advertisements include RSSI, name, tx power, and manufacturer data.
	 *
	 * @param callback - Called when an advertisement is received
	 * @returns Unsubscribe function
	 */
	onAdvertisement?(callback: (event: AdvertisementEvent) => void): () => void;
}

/**
 * Represents a BLE GATT descriptor.
 * Descriptors provide additional information about a characteristic's value.
 */
export interface BLEGATTDescriptor {
	/** The UUID of this descriptor */
	uuid: string;

	/**
	 * Reads the value of this descriptor.
	 * @returns Promise resolving to the descriptor value
	 */
	readValue(): Promise<DataView>;

	/**
	 * Writes a value to this descriptor.
	 * @param value - The data to write
	 */
	writeValue(value: BufferSource): Promise<void>;
}

/**
 * Represents a BLE GATT service.
 * A service is a collection of characteristics that define a feature or behavior.
 */
export interface BLEGATTService {
	/** The UUID of this service (e.g., '1826' for FTMS) */
	uuid: string;

	/**
	 * Retrieves all characteristics belonging to this service.
	 * @returns Promise resolving to an array of characteristics
	 */
	getCharacteristics(): Promise<BLEGATTCharacteristic[]>;

	/**
	 * Retrieves a specific characteristic by UUID.
	 * @param uuid - The characteristic UUID to retrieve
	 * @returns Promise resolving to the characteristic
	 * @throws Error if characteristic not found
	 */
	getCharacteristic(
		uuid: BluetoothCharacteristicUUID,
	): Promise<BLEGATTCharacteristic>;
}

/**
 * Represents a BLE GATT characteristic.
 * Characteristics are the primary way to read/write data to BLE devices.
 */
export interface BLEGATTCharacteristic {
	/** The UUID of this characteristic */
	uuid: string;

	/** Properties indicating what operations this characteristic supports */
	properties: CharacteristicProperties;

	/**
	 * Reads the current value of this characteristic.
	 * @returns Promise resolving to the characteristic value
	 */
	readValue(): Promise<DataView>;

	/**
	 * Writes a value to the characteristic and waits for acknowledgment.
	 * @param value - The data to write
	 * @throws Error if the write fails or times out
	 */
	writeValueWithResponse(
		value: ArrayBuffer | Uint8Array | DataView,
	): Promise<void>;

	/**
	 * Writes a value to the characteristic without waiting for acknowledgment.
	 * Faster than writeValueWithResponse but provides no delivery confirmation.
	 * @param value - The data to write
	 */
	writeValueWithoutResponse(
		value: ArrayBuffer | Uint8Array | DataView,
	): Promise<void>;

	/**
	 * Enables notifications for this characteristic.
	 * After calling this, 'characteristicvaluechanged' events will fire when the device sends data.
	 */
	startNotifications(): Promise<void>;

	/**
	 * Disables notifications for this characteristic.
	 */
	stopNotifications(): Promise<void>;

	/**
	 * Retrieves a specific descriptor by UUID.
	 * @param uuid - The descriptor UUID to retrieve
	 * @returns Promise resolving to the descriptor
	 * @throws Error if descriptor not found
	 */
	getDescriptor(uuid: BluetoothDescriptorUUID): Promise<BLEGATTDescriptor>;

	/**
	 * Retrieves all descriptors, or a specific descriptor by UUID.
	 * @param uuid - Optional descriptor UUID to filter by
	 * @returns Promise resolving to an array of descriptors
	 */
	getDescriptors(uuid?: BluetoothDescriptorUUID): Promise<BLEGATTDescriptor[]>;

	/**
	 * Adds an event listener for characteristic events.
	 * @param type - Event type (typically 'characteristicvaluechanged')
	 * @param listener - The event handler
	 */
	addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
	): void;

	/**
	 * Removes an event listener.
	 * @param type - Event type
	 * @param listener - The event handler to remove
	 */
	removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
	): void;

	/**
	 * The last value received from this characteristic.
	 * Updated when notifications fire or after a read operation.
	 *
	 * @remarks
	 * Returns `undefined` (not `null`) to match the Web Bluetooth API behavior.
	 * This is intentional and distinct from `null` which is used elsewhere
	 * in this library to indicate "intentionally empty".
	 */
	get value(): DataView | undefined;
}

/**
 * Adapter interface for BLE connectivity.
 * Implement this interface to provide custom Bluetooth backends
 * (e.g., Web Bluetooth, Node.js BLE libraries, React Native BLE).
 *
 * @remarks
 * The default implementation uses Web Bluetooth API via `createWebBluetoothAdapter()`.
 * Custom adapters must implement `connect()` and optionally `reconnect()` and `forgetDevice()`.
 *
 * @example Custom adapter
 * ```typescript
 * const myAdapter: BLEAdapter = {
 *   async connect(options) {
 *     const device = await myBleLibrary.scan(options.filters);
 *     await device.connect();
 *     return createSessionFromDevice(device);
 *   },
 *   async reconnect() {
 *     const cached = await myBleLibrary.getCachedDevice();
 *     if (!cached) return null;
 *     await cached.connect();
 *     return createSessionFromDevice(cached);
 *   }
 * };
 * ```
 */
export interface BLEAdapter<
	TConnectOptions extends BLEConnectOptions = BLEConnectOptions,
> {
	/**
	 * Initiates a new connection to a BLE device.
	 * Typically shows a device picker dialog to the user.
	 *
	 * @param options - Connection options including device filters (optional)
	 * @returns Promise resolving to a connected session
	 * @throws Error if connection fails or is cancelled
	 */
	connect(options?: TConnectOptions): Promise<BLEConnectedSession>;

	/**
	 * Attempts to reconnect to a previously paired device.
	 * Uses cached device information to connect without user interaction.
	 *
	 * @returns Promise resolving to a connected session, or null if no device found
	 * @throws Error if reconnection fails (device found but connection failed)
	 */
	reconnect?(): Promise<BLEConnectedSession | null>;

	/**
	 * Clears the remembered device ID from storage.
	 * Only available on adapters that support device persistence.
	 */
	forgetDevice?(): void;

	/**
	 * Checks if Bluetooth is available on this device.
	 * Use this to gracefully degrade when Bluetooth isn't supported.
	 *
	 * @returns Promise resolving to true if Bluetooth is available
	 */
	getAvailability?(): Promise<boolean>;
}

/**
 * Storage interface for persisting device IDs.
 */
export interface DeviceStorage {
	get(): string | null;
	set(deviceId: string): void;
	remove(): void;
}
