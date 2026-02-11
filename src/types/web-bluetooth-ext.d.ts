/**
 * Extended Web Bluetooth type definitions.
 *
 * These types augment the standard @types/web-bluetooth definitions with
 * additional properties that are available in Chrome's implementation but
 * not yet in the standard TypeScript definitions.
 */

/**
 * Extended BluetoothAdvertisingEvent with all Chrome-supported properties.
 * This interface represents the event fired when a Bluetooth advertisement is received.
 */
export interface BluetoothAdvertisingEvent extends Event {
	/** The BluetoothDevice that sent the advertisement */
	readonly device: BluetoothDevice;
	/** Received Signal Strength Indicator in dBm, or undefined if not available */
	readonly rssi?: number;
	/** The local name of the device, or undefined if not included in advertisement */
	readonly name?: string;
	/** The transmit power level in dBm, or undefined if not available */
	readonly txPower?: number;
	/** Map of manufacturer-specific data, keyed by company identifier */
	readonly manufacturerData?: Map<number, DataView>;
	/** Map of service-specific data, keyed by service UUID */
	readonly serviceData?: Map<string, DataView>;
	/** List of service UUIDs advertised by the device */
	readonly uuids?: string[];
}

/**
 * Extended BluetoothDevice interface with advertisement watching capabilities.
 */
export interface BluetoothDeviceWithAdvertisements extends BluetoothDevice {
	/** Whether the device is currently watching for advertisements */
	readonly watchingAdvertisements?: boolean;
}
