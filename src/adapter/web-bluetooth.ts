import { raceWithAbort, throwIfAborted, withTimeout } from "../errors/errors";
import { createEventEmitter, type TypedEventEmitter } from "../state";
import type {
	AdvertisementEvent,
	BLEAdapter,
	BLEConnectedSession,
	BLEConnectOptions,
	BLEGATTCharacteristic,
	BLEGATTDescriptor,
	BLEGATTService,
} from "../types";
import type {
	BluetoothAdvertisingEvent,
	BluetoothDeviceWithAdvertisements,
} from "../types/web-bluetooth-ext";
import { type DeviceStorage, getDefaultStorage } from "../utils/storage";
import { toFullUuid } from "../utils/uuid";

/** Default timeout for GATT connection in milliseconds */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 20000;

function getBluetooth(): Bluetooth {
	if (typeof navigator === "undefined" || !navigator.bluetooth) {
		throw new Error("Web Bluetooth not available");
	}
	return navigator.bluetooth;
}

function adaptDescriptor(
	desc: BluetoothRemoteGATTDescriptor,
): BLEGATTDescriptor {
	return {
		uuid: desc.uuid,
		readValue: () => desc.readValue(),
		writeValue: (value) => desc.writeValue(value),
	};
}

function adaptCharacteristic(
	char: BluetoothRemoteGATTCharacteristic,
): BLEGATTCharacteristic {
	return {
		uuid: char.uuid,
		properties: {
			broadcast: char.properties.broadcast,
			read: char.properties.read,
			writeWithoutResponse: char.properties.writeWithoutResponse,
			write: char.properties.write,
			notify: char.properties.notify,
			indicate: char.properties.indicate,
			authenticatedSignedWrites: char.properties.authenticatedSignedWrites,
			reliableWrite: char.properties.reliableWrite,
			writableAuxiliaries: char.properties.writableAuxiliaries,
		},
		readValue: () => char.readValue(),
		writeValueWithResponse: (value) =>
			char.writeValueWithResponse(value as BufferSource),
		writeValueWithoutResponse: (value) =>
			char.writeValueWithoutResponse(value as BufferSource),
		startNotifications: () => char.startNotifications().then(() => {}),
		stopNotifications: () => char.stopNotifications().then(() => {}),
		getDescriptor: async (uuid) => {
			const desc = await char.getDescriptor(uuid);
			return adaptDescriptor(desc);
		},
		getDescriptors: async (uuid) => {
			const descs = uuid
				? await char.getDescriptors(uuid)
				: await char.getDescriptors();
			return descs.map(adaptDescriptor);
		},
		addEventListener: (type, listener) => char.addEventListener(type, listener),
		removeEventListener: (type, listener) =>
			char.removeEventListener(type, listener),
		get value() {
			return char.value;
		},
	};
}

function adaptService(service: BluetoothRemoteGATTService): BLEGATTService {
	return {
		uuid: service.uuid,
		getCharacteristics: async () => {
			const chars = await service.getCharacteristics();
			return chars.map(adaptCharacteristic);
		},
		getCharacteristic: async (uuid) => {
			const char = await service.getCharacteristic(uuid);
			return adaptCharacteristic(char);
		},
	};
}

interface AdvertisementEvents extends Record<string, unknown> {
	advertisement: AdvertisementEvent;
}

/**
 * Extracts advertising data from a raw Event with type-safe access.
 * Returns an AdvertisementEvent with only the defined properties.
 */
function extractAdvertisingData(event: Event): AdvertisementEvent {
	const advEvent = event as BluetoothAdvertisingEvent;
	const data: AdvertisementEvent = {};

	if (advEvent.rssi !== undefined) data.rssi = advEvent.rssi;
	if (advEvent.name !== undefined) data.name = advEvent.name;
	if (advEvent.txPower !== undefined) data.txPower = advEvent.txPower;
	if (advEvent.manufacturerData !== undefined)
		data.manufacturerData = advEvent.manufacturerData;
	if (advEvent.serviceData !== undefined)
		data.serviceData = advEvent.serviceData;
	if (advEvent.uuids !== undefined) data.uuids = advEvent.uuids;

	return data;
}

function createSession(server: BluetoothRemoteGATTServer): BLEConnectedSession {
	const device = server.device;
	let currentRssi: number | undefined;
	let isWatchingAdvertisements = false;
	const advertisementEmitter: TypedEventEmitter<AdvertisementEvents> =
		createEventEmitter();

	// Handler for advertisement events
	const handleAdvertisement = (event: Event): void => {
		const advData = extractAdvertisingData(event);

		// Update current RSSI
		if (advData.rssi !== undefined) {
			currentRssi = advData.rssi;
		}

		advertisementEmitter.emit("advertisement", advData);
	};

	return {
		deviceId: device.id,
		deviceName: device.name,
		async getPrimaryServices(): Promise<BLEGATTService[]> {
			const services = await server.getPrimaryServices();
			return services.map(adaptService);
		},
		async getPrimaryService(
			uuid: BluetoothServiceUUID,
		): Promise<BLEGATTService> {
			const service = await server.getPrimaryService(uuid);
			return adaptService(service);
		},
		async disconnect(): Promise<void> {
			try {
				// Clean up advertisement watching
				if (isWatchingAdvertisements) {
					device.removeEventListener(
						"advertisementreceived",
						handleAdvertisement,
					);
					isWatchingAdvertisements = false;
				}
				server.disconnect();
			} catch (e) {
				console.warn(
					"[web-ble-kit] Error during GATT disconnect:",
					e instanceof Error ? e.message : String(e),
				);
			}
		},
		onDisconnect(callback: () => void): () => void {
			const handler = () => {
				callback();
			};
			device.addEventListener("gattserverdisconnected", handler);
			return () => {
				device.removeEventListener("gattserverdisconnected", handler);
			};
		},

		// Advertisement watching for RSSI monitoring
		async watchAdvertisements(): Promise<void> {
			if (isWatchingAdvertisements) {
				return; // Already watching
			}

			// Check if the API is available
			if (typeof device.watchAdvertisements !== "function") {
				throw new Error(
					"watchAdvertisements is not supported in this browser. " +
						'Try enabling "Experimental Web Platform features" in chrome://flags',
				);
			}

			device.addEventListener("advertisementreceived", handleAdvertisement);
			isWatchingAdvertisements = true;

			try {
				await device.watchAdvertisements();
			} catch (e) {
				// Clean up on failure
				device.removeEventListener(
					"advertisementreceived",
					handleAdvertisement,
				);
				isWatchingAdvertisements = false;
				throw e;
			}
		},

		unwatchAdvertisements(): void {
			if (!isWatchingAdvertisements) {
				return;
			}

			device.removeEventListener("advertisementreceived", handleAdvertisement);
			isWatchingAdvertisements = false;
			// Note: Web Bluetooth API doesn't have unwatchAdvertisements()
			// The browser may continue scanning, but we won't receive events
		},

		get watchingAdvertisements(): boolean {
			// Use the device's property if available, fall back to our tracking
			const extDevice = device as BluetoothDeviceWithAdvertisements;
			return extDevice.watchingAdvertisements ?? isWatchingAdvertisements;
		},

		get rssi(): number | undefined {
			return currentRssi;
		},

		onAdvertisement(callback: (event: AdvertisementEvent) => void): () => void {
			return advertisementEmitter.on("advertisement", callback);
		},
	};
}

function isMatchingDeviceName(
	name: string | undefined,
	prefixes: readonly string[],
): boolean {
	if (!name) return false;
	const trimmed = name.trim();
	return prefixes.some((prefix) => trimmed.startsWith(prefix));
}

export interface WebBluetoothAdapterOptions {
	/**
	 * Storage implementation for persisting device IDs.
	 * Defaults to localStorage with graceful fallback.
	 */
	storage?: DeviceStorage;

	/**
	 * Timeout for GATT connection in milliseconds.
	 * Bluetooth connections can hang for 30+ seconds on some devices.
	 * @default 20000 (20 seconds)
	 */
	connectionTimeoutMs?: number;

	/**
	 * Device name prefixes to match during reconnection.
	 * Used to identify devices when no remembered device ID is available.
	 * @default []
	 */
	namePrefixes?: readonly string[];

	/**
	 * Optional service UUIDs to request access to.
	 * These are added to optionalServices in requestDevice().
	 */
	optionalServices?: (number | string)[];

	/**
	 * Default filters for device discovery.
	 * Used when no filters are provided in connect().
	 */
	defaultFilters?: BluetoothLEScanFilter[];

	/**
	 * Log prefix for warning messages.
	 * @default '[web-ble-kit]'
	 */
	logPrefix?: string;
}

function buildRequestOptions(
	options: BLEConnectOptions,
	adapterOptions: WebBluetoothAdapterOptions,
): RequestDeviceOptions {
	const optionalServices: BluetoothServiceUUID[] = (
		options.optionalServices ??
		adapterOptions.optionalServices ??
		[]
	).map((u) => (typeof u === "number" ? toFullUuid(u) : String(u)));

	const filters: BluetoothLEScanFilter[] | undefined = options.filters?.length
		? options.filters
				.map((f) => {
					const filter: BluetoothLEScanFilter = {};
					if (f.namePrefix != null)
						(filter as { namePrefix?: string }).namePrefix = f.namePrefix;
					if (f.name != null) (filter as { name?: string }).name = f.name;
					if (f.services != null)
						(filter as { services?: BluetoothServiceUUID[] }).services =
							f.services;
					return filter;
				})
				.filter((f) => Object.keys(f).length > 0)
		: undefined;

	const namePrefixes = adapterOptions.namePrefixes ?? [];
	const defaultFilters = adapterOptions.defaultFilters ?? [];

	const effectiveFilters: BluetoothLEScanFilter[] = filters?.length
		? filters
		: defaultFilters.length > 0
			? defaultFilters
			: namePrefixes.length > 0
				? namePrefixes.map((prefix) => ({ namePrefix: prefix }))
				: [{ acceptAllDevices: true } as unknown as BluetoothLEScanFilter];

	// Handle acceptAllDevices case
	const hasAcceptAll = effectiveFilters.some(
		(f) =>
			"acceptAllDevices" in f &&
			(f as { acceptAllDevices?: boolean }).acceptAllDevices,
	);

	if (hasAcceptAll) {
		return {
			acceptAllDevices: true,
			optionalServices,
		};
	}

	return {
		filters: effectiveFilters,
		optionalServices,
	};
}

/**
 * Creates a Web Bluetooth adapter that implements the BLEAdapter interface.
 * This adapter uses the native Web Bluetooth API available in modern browsers.
 *
 * @param options - Adapter configuration options
 * @returns A BLEAdapter for use with device managers
 *
 * @example Default usage (localStorage persistence)
 * ```typescript
 * const adapter = createWebBluetoothAdapter();
 * ```
 *
 * @example Disable device persistence
 * ```typescript
 * import { createNoOpStorage } from 'web-ble-kit';
 * const adapter = createWebBluetoothAdapter({ storage: createNoOpStorage() });
 * ```
 *
 * @example Custom storage
 * ```typescript
 * const adapter = createWebBluetoothAdapter({
 *   storage: {
 *     get: () => myStore.getDeviceId(),
 *     set: (id) => myStore.setDeviceId(id),
 *     remove: () => myStore.clearDeviceId(),
 *   }
 * });
 * ```
 */
export function createWebBluetoothAdapter(
	options: WebBluetoothAdapterOptions = {},
): BLEAdapter {
	const storage = options.storage ?? getDefaultStorage();
	const connectionTimeoutMs =
		options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
	const namePrefixes = options.namePrefixes ?? [];
	const logPrefix = options.logPrefix ?? "[web-ble-kit]";

	return {
		async connect(
			connectOptions: BLEConnectOptions = {},
		): Promise<BLEConnectedSession> {
			const signal = connectOptions.signal;

			// Fail fast if already aborted
			throwIfAborted(signal);

			const bluetooth = getBluetooth();
			const requestOptions = buildRequestOptions(connectOptions, options);

			// Race device request against abort signal
			const device: BluetoothDevice = await raceWithAbort(
				bluetooth.requestDevice(requestOptions),
				signal,
			);

			// Check abort after device selection (user may have cancelled during picker)
			throwIfAborted(signal);

			if (!device.gatt) {
				throw new Error("No GATT server");
			}

			if (device.id && device.id.length > 0 && connectOptions.rememberDevice) {
				storage.set(device.id);
			}

			// Race GATT connection against abort signal
			const server: BluetoothRemoteGATTServer = await raceWithAbort(
				withTimeout(
					device.gatt.connect(),
					connectionTimeoutMs,
					"GATT connection",
				),
				signal,
			);

			return createSession(server);
		},

		async reconnect(): Promise<BLEConnectedSession | null> {
			const bluetooth = getBluetooth();

			if (typeof bluetooth.getDevices !== "function") {
				return null;
			}

			const devices: BluetoothDevice[] = await bluetooth.getDevices();
			const rememberedId = storage.get();

			const preferredDevice = rememberedId
				? devices.find((d) => d.id === rememberedId)
				: undefined;
			const targetDevice =
				preferredDevice ??
				devices.find((d) => isMatchingDeviceName(d.name, namePrefixes));

			if (!targetDevice?.gatt) {
				return null;
			}

			try {
				const server: BluetoothRemoteGATTServer = await withTimeout(
					targetDevice.gatt.connect(),
					connectionTimeoutMs,
					"GATT reconnection",
				);
				return createSession(server);
			} catch (e) {
				console.warn(
					`${logPrefix} Reconnect failed:`,
					e instanceof Error ? e.message : String(e),
				);
				return null;
			}
		},

		forgetDevice(): void {
			storage.remove();
		},

		async getAvailability(): Promise<boolean> {
			try {
				const bluetooth = getBluetooth();
				if (typeof bluetooth.getAvailability === "function") {
					return bluetooth.getAvailability();
				}
				// If getAvailability is not supported, assume available
				// since we were able to get the bluetooth object
				return true;
			} catch {
				// Web Bluetooth not available
				return false;
			}
		},
	};
}
