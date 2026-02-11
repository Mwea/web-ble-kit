import type { DeviceStorage } from "../types";

export type { DeviceStorage } from "../types";

const DEFAULT_STORAGE_KEY = "web-ble-kit-device-id";

export interface StorageOptions {
	/** Storage key to use. Defaults to 'web-ble-kit-device-id' */
	key?: string;
}

function createWebStorage(
	storage: Storage,
	name: string,
	options: StorageOptions = {},
): DeviceStorage {
	const key = options.key ?? DEFAULT_STORAGE_KEY;

	return {
		get(): string | null {
			try {
				return storage.getItem(key);
			} catch (e) {
				console.warn(
					`[web-ble-kit] Could not read device ID from ${name}:`,
					e instanceof Error ? e.message : String(e),
				);
				return null;
			}
		},

		set(deviceId: string): void {
			try {
				storage.setItem(key, deviceId);
			} catch (e) {
				console.warn(
					`[web-ble-kit] Could not save device ID to ${name}:`,
					e instanceof Error ? e.message : String(e),
				);
			}
		},

		remove(): void {
			try {
				storage.removeItem(key);
			} catch (e) {
				console.warn(
					`[web-ble-kit] Could not clear device ID from ${name}:`,
					e instanceof Error ? e.message : String(e),
				);
			}
		},
	};
}

/**
 * Creates a DeviceStorage backed by localStorage.
 *
 * @security **Same-Origin Access**: Device IDs stored in localStorage are accessible
 * to any JavaScript running on the same origin. Consider security implications:
 * - XSS attacks could extract stored device IDs
 * - Other scripts on the same origin can read/modify values
 * - Data persists across browser sessions
 *
 * For sensitive applications, consider using `createNoOpStorage()` to disable
 * persistence, `createSessionStorage()` for session-only storage, or implement
 * custom encrypted storage.
 *
 * @param options - Storage configuration options
 * @returns A DeviceStorage implementation using localStorage
 * @throws Error if localStorage is not available
 */
export function createLocalStorage(
	options: StorageOptions = {},
): DeviceStorage {
	if (typeof localStorage === "undefined") {
		throw new Error("localStorage is not available in this environment");
	}
	return createWebStorage(localStorage, "localStorage", options);
}

export function createSessionStorage(
	options: StorageOptions = {},
): DeviceStorage {
	if (typeof sessionStorage === "undefined") {
		throw new Error("sessionStorage is not available in this environment");
	}
	return createWebStorage(sessionStorage, "sessionStorage", options);
}

export function createMemoryStorage(): DeviceStorage {
	let storedDeviceId: string | null = null;

	return {
		get(): string | null {
			return storedDeviceId;
		},

		set(deviceId: string): void {
			storedDeviceId = deviceId;
		},

		remove(): void {
			storedDeviceId = null;
		},
	};
}

export function createNoOpStorage(): DeviceStorage {
	return {
		get(): string | null {
			return null;
		},

		set(): void {},

		remove(): void {},
	};
}

let defaultStorage: DeviceStorage | null = null;

export function getDefaultStorage(): DeviceStorage {
	if (!defaultStorage) {
		try {
			defaultStorage = createLocalStorage();
		} catch {
			defaultStorage = createNoOpStorage();
		}
	}
	return defaultStorage;
}
