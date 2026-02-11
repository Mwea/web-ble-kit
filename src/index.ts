/**
 * web-ble-kit - Generic Web Bluetooth infrastructure for device libraries.
 *
 * @packageDocumentation
 *
 * @example Basic usage
 * ```typescript
 * import {
 *   createWebBluetoothAdapter,
 *   createStateMachine,
 *   createEventEmitter,
 *   writeWithTimeout,
 *   startNotifications,
 * } from 'web-ble-kit';
 *
 * const adapter = createWebBluetoothAdapter({
 *   namePrefixes: ['MyDevice'],
 *   optionalServices: ['1826'],
 * });
 *
 * const session = await adapter.connect();
 * ```
 */

// Adapter
export {
	createWebBluetoothAdapter,
	type WebBluetoothAdapterOptions,
} from "./adapter";
// Async utilities
export {
	createPollManager,
	type PollManager,
	type PollManagerOptions,
	type PollStartOptions,
} from "./async";

// BLE transport
export {
	type BLERetryOptions,
	type ConnectionPool,
	type ConnectionPoolEvents,
	type ConnectionPoolOptions,
	connectWithRetry,
	createConnectionPool,
	createOperationQueue,
	MAX_BLE_CONNECTIONS,
	type OperationQueue,
	type OperationQueueOptions,
	type ReadOptions,
	type RetryOptions,
	readWithRetry,
	readWithTimeout,
	type StartNotificationsOptions,
	startNotifications,
	type WriteOptions,
	withRetry,
	writeWithRetry,
	writeWithTimeout,
} from "./ble";
// Errors
export {
	AbortError,
	isTransientBLEError,
	NotConnectedError,
	raceWithAbort,
	TimeoutError,
	withTimeout,
} from "./errors";
// State management
export {
	type CleanableEventTarget,
	createEventEmitter,
	createStateMachine,
	type EventMap,
	type StateMachine,
	type TransitionCallback,
	type TypedEventEmitter,
	toEventTarget,
} from "./state";
// Types
export type {
	AdvertisementEvent,
	BLEAdapter,
	BLEConnectedSession,
	BLEConnectOptions,
	BLEGATTCharacteristic,
	BLEGATTDescriptor,
	BLEGATTService,
	CharacteristicProperties,
	ConnectionState,
	DeviceStorage,
	RequestDeviceFilter,
} from "./types";
// Utils
export {
	BLUETOOTH_UUID_BASE,
	createLocalStorage,
	createMemoryStorage,
	createNoOpStorage,
	createSessionStorage,
	extractArrayBuffer,
	readByte,
	readUint16LE,
	readUint24BE,
	readUint24LE,
	type StorageOptions,
	toFullUuid,
	uuidMatches,
} from "./utils";
