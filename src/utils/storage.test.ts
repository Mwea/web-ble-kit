import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeviceStorage } from "../types";
import {
	createLocalStorage,
	createMemoryStorage,
	createNoOpStorage,
	createSessionStorage,
	getDefaultStorage,
} from "./storage";

const DEFAULT_KEY = "web-ble-kit-device-id";

describe("createMemoryStorage", () => {
	it("returns null initially", () => {
		const storage = createMemoryStorage();
		expect(storage.get()).toBeNull();
	});

	it("stores and retrieves device ID", () => {
		const storage = createMemoryStorage();
		storage.set("device-123");
		expect(storage.get()).toBe("device-123");
	});

	it("removes device ID", () => {
		const storage = createMemoryStorage();
		storage.set("device-123");
		storage.remove();
		expect(storage.get()).toBeNull();
	});

	it("overwrites previous value", () => {
		const storage = createMemoryStorage();
		storage.set("device-1");
		storage.set("device-2");
		expect(storage.get()).toBe("device-2");
	});

	it("creates independent instances", () => {
		const storage1 = createMemoryStorage();
		const storage2 = createMemoryStorage();
		storage1.set("device-1");
		expect(storage2.get()).toBeNull();
	});
});

describe("createNoOpStorage", () => {
	it("always returns null", () => {
		const storage = createNoOpStorage();
		expect(storage.get()).toBeNull();
	});

	it("ignores set calls", () => {
		const storage = createNoOpStorage();
		storage.set("device-123");
		expect(storage.get()).toBeNull();
	});

	it("ignores remove calls", () => {
		const storage = createNoOpStorage();
		expect(() => storage.remove()).not.toThrow();
	});
});

describe("createLocalStorage", () => {
	let originalLocalStorage: Storage;
	let mockStorage: Map<string, string>;

	beforeEach(() => {
		originalLocalStorage = globalThis.localStorage;
		mockStorage = new Map();

		// Create a mock localStorage
		Object.defineProperty(globalThis, "localStorage", {
			value: {
				getItem: (key: string) => mockStorage.get(key) ?? null,
				setItem: (key: string, value: string) => mockStorage.set(key, value),
				removeItem: (key: string) => mockStorage.delete(key),
			},
			writable: true,
			configurable: true,
		});
	});

	afterEach(() => {
		Object.defineProperty(globalThis, "localStorage", {
			value: originalLocalStorage,
			writable: true,
			configurable: true,
		});
	});

	it("stores and retrieves from localStorage", () => {
		const storage = createLocalStorage();
		storage.set("device-456");
		expect(mockStorage.get(DEFAULT_KEY)).toBe("device-456");
		expect(storage.get()).toBe("device-456");
	});

	it("removes from localStorage", () => {
		const storage = createLocalStorage();
		storage.set("device-456");
		storage.remove();
		expect(mockStorage.has(DEFAULT_KEY)).toBe(false);
		expect(storage.get()).toBeNull();
	});

	it("handles localStorage errors gracefully on get", () => {
		const storage = createLocalStorage();

		// Make getItem throw
		Object.defineProperty(globalThis, "localStorage", {
			value: {
				getItem: () => {
					throw new Error("Storage disabled");
				},
				setItem: () => {},
				removeItem: () => {},
			},
			writable: true,
			configurable: true,
		});

		expect(storage.get()).toBeNull();
	});

	it("handles localStorage errors gracefully on set", () => {
		const storage = createLocalStorage();

		Object.defineProperty(globalThis, "localStorage", {
			value: {
				getItem: () => null,
				setItem: () => {
					throw new Error("Quota exceeded");
				},
				removeItem: () => {},
			},
			writable: true,
			configurable: true,
		});

		expect(() => storage.set("device-123")).not.toThrow();
	});

	it("handles localStorage errors gracefully on remove", () => {
		const storage = createLocalStorage();

		Object.defineProperty(globalThis, "localStorage", {
			value: {
				getItem: () => null,
				setItem: () => {},
				removeItem: () => {
					throw new Error("Storage error");
				},
			},
			writable: true,
			configurable: true,
		});

		expect(() => storage.remove()).not.toThrow();
	});
});

describe("createSessionStorage", () => {
	let originalSessionStorage: Storage;
	let mockStorage: Map<string, string>;

	beforeEach(() => {
		originalSessionStorage = globalThis.sessionStorage;
		mockStorage = new Map();

		Object.defineProperty(globalThis, "sessionStorage", {
			value: {
				getItem: (key: string) => mockStorage.get(key) ?? null,
				setItem: (key: string, value: string) => mockStorage.set(key, value),
				removeItem: (key: string) => mockStorage.delete(key),
			},
			writable: true,
			configurable: true,
		});
	});

	afterEach(() => {
		Object.defineProperty(globalThis, "sessionStorage", {
			value: originalSessionStorage,
			writable: true,
			configurable: true,
		});
	});

	it("stores and retrieves from sessionStorage", () => {
		const storage = createSessionStorage();
		storage.set("device-789");
		expect(mockStorage.get(DEFAULT_KEY)).toBe("device-789");
		expect(storage.get()).toBe("device-789");
	});

	it("removes from sessionStorage", () => {
		const storage = createSessionStorage();
		storage.set("device-789");
		storage.remove();
		expect(storage.get()).toBeNull();
	});
});

describe("getDefaultStorage", () => {
	it("returns a storage instance", () => {
		const storage = getDefaultStorage();
		expect(storage).toBeDefined();
		expect(typeof storage.get).toBe("function");
		expect(typeof storage.set).toBe("function");
		expect(typeof storage.remove).toBe("function");
	});

	it("returns the same instance on subsequent calls", () => {
		const storage1 = getDefaultStorage();
		const storage2 = getDefaultStorage();
		expect(storage1).toBe(storage2);
	});
});

describe("DeviceStorage interface", () => {
	it("allows custom implementation", () => {
		const customData = new Map<string, string>();

		const customStorage: DeviceStorage = {
			get: () => customData.get("device") ?? null,
			set: (id) => customData.set("device", id),
			remove: () => customData.delete("device"),
		};

		expect(customStorage.get()).toBeNull();
		customStorage.set("custom-device-id");
		expect(customStorage.get()).toBe("custom-device-id");
		customStorage.remove();
		expect(customStorage.get()).toBeNull();
	});
});
