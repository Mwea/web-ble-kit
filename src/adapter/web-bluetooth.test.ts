/**
 * Tests for web-bluetooth adapter
 * Covers: C-001, M-004 (toFullUuid validation)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AbortError } from "../errors";
import { BLUETOOTH_UUID_BASE, toFullUuid } from "../utils";
import { createWebBluetoothAdapter } from "./web-bluetooth";

// Mock types for Web Bluetooth API
interface MockBluetoothDevice {
	id: string;
	name?: string;
	gatt?: MockBluetoothRemoteGATTServer | undefined;
	addEventListener: ReturnType<typeof vi.fn>;
	removeEventListener: ReturnType<typeof vi.fn>;
	watchAdvertisements?: ReturnType<typeof vi.fn>;
}

interface MockBluetoothRemoteGATTServer {
	device: MockBluetoothDevice;
	connected: boolean;
	connect: ReturnType<typeof vi.fn>;
	disconnect: ReturnType<typeof vi.fn>;
	getPrimaryServices: ReturnType<typeof vi.fn>;
	getPrimaryService: ReturnType<typeof vi.fn>;
}

interface MockBluetooth {
	requestDevice: ReturnType<typeof vi.fn>;
	getDevices: ReturnType<typeof vi.fn>;
	getAvailability: ReturnType<typeof vi.fn>;
}

function createMockDevice(
	overrides: Partial<MockBluetoothDevice> = {},
): MockBluetoothDevice {
	const device: MockBluetoothDevice = {
		id: "test-device-id",
		name: "TestDevice",
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		...overrides,
	};

	const server: MockBluetoothRemoteGATTServer = {
		device,
		connected: true,
		connect: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn(),
		getPrimaryServices: vi.fn().mockResolvedValue([]),
		getPrimaryService: vi.fn().mockResolvedValue({
			uuid: "test-service",
			getCharacteristics: vi.fn().mockResolvedValue([]),
			getCharacteristic: vi.fn(),
		}),
	};

	// Make connect return the server
	server.connect.mockImplementation(() => Promise.resolve(server));

	device.gatt = server;
	return device;
}

function createMockBluetooth(): MockBluetooth {
	return {
		requestDevice: vi.fn(),
		getDevices: vi.fn().mockResolvedValue([]),
		getAvailability: vi.fn().mockResolvedValue(true),
	};
}

describe("toFullUuid", () => {
	describe("valid inputs", () => {
		it("converts number to full UUID", () => {
			expect(toFullUuid(0xfe00)).toBe(`0000fe00${BLUETOOTH_UUID_BASE}`);
		});

		it("converts 4-char hex string to full UUID", () => {
			expect(toFullUuid("fe00")).toBe(`0000fe00${BLUETOOTH_UUID_BASE}`);
		});

		it("converts uppercase hex string to lowercase", () => {
			expect(toFullUuid("FE00")).toBe(`0000fe00${BLUETOOTH_UUID_BASE}`);
		});

		it("pads short hex strings", () => {
			expect(toFullUuid("1")).toBe(`00000001${BLUETOOTH_UUID_BASE}`);
			expect(toFullUuid("01")).toBe(`00000001${BLUETOOTH_UUID_BASE}`);
			expect(toFullUuid("001")).toBe(`00000001${BLUETOOTH_UUID_BASE}`);
		});

		it("handles zero", () => {
			expect(toFullUuid(0)).toBe(`00000000${BLUETOOTH_UUID_BASE}`);
			expect(toFullUuid("0")).toBe(`00000000${BLUETOOTH_UUID_BASE}`);
		});

		it("handles max 16-bit value", () => {
			expect(toFullUuid(0xffff)).toBe(`0000ffff${BLUETOOTH_UUID_BASE}`);
		});
	});

	// M-004: These tests expose missing validation
	describe("input validation (M-004)", () => {
		it("should reject numbers > 0xFFFF", () => {
			// Current behavior: no validation, produces invalid UUID
			// Expected: should throw RangeError
			expect(() => toFullUuid(0x10000)).toThrow(RangeError);
		});

		it("should reject negative numbers", () => {
			expect(() => toFullUuid(-1)).toThrow(RangeError);
		});

		it("should reject non-hex strings", () => {
			expect(() => toFullUuid("ghij")).toThrow();
		});

		it("should reject empty string", () => {
			expect(() => toFullUuid("")).toThrow();
		});

		it("should reject strings longer than 4 chars", () => {
			// 5+ character strings are invalid short UUIDs
			expect(() => toFullUuid("12345")).toThrow();
		});
	});
});

describe("createWebBluetoothAdapter", () => {
	let mockBluetooth: MockBluetooth;
	let originalNavigator: typeof globalThis.navigator;

	beforeEach(() => {
		mockBluetooth = createMockBluetooth();
		originalNavigator = globalThis.navigator;

		// Mock navigator.bluetooth
		Object.defineProperty(globalThis, "navigator", {
			value: { bluetooth: mockBluetooth },
			writable: true,
			configurable: true,
		});
	});

	afterEach(() => {
		Object.defineProperty(globalThis, "navigator", {
			value: originalNavigator,
			writable: true,
			configurable: true,
		});
		vi.restoreAllMocks();
	});

	describe("connect", () => {
		it("requests device and connects to GATT server", async () => {
			const mockDevice = createMockDevice();
			mockBluetooth.requestDevice.mockResolvedValue(mockDevice);

			const adapter = createWebBluetoothAdapter();
			const session = await adapter.connect();

			expect(mockBluetooth.requestDevice).toHaveBeenCalled();
			expect(mockDevice.gatt?.connect).toHaveBeenCalled();
			expect(session.deviceId).toBe("test-device-id");
			expect(session.deviceName).toBe("TestDevice");
		});

		it("throws if no GATT server available", async () => {
			const mockDevice = createMockDevice();
			mockDevice.gatt = undefined;
			mockBluetooth.requestDevice.mockResolvedValue(mockDevice);

			const adapter = createWebBluetoothAdapter();
			await expect(adapter.connect()).rejects.toThrow("No GATT server");
		});

		it("stores device ID when rememberDevice is true", async () => {
			const mockDevice = createMockDevice();
			mockBluetooth.requestDevice.mockResolvedValue(mockDevice);

			const mockStorage = {
				get: vi.fn().mockReturnValue(null),
				set: vi.fn(),
				remove: vi.fn(),
			};

			const adapter = createWebBluetoothAdapter({ storage: mockStorage });
			await adapter.connect({ rememberDevice: true });

			expect(mockStorage.set).toHaveBeenCalledWith("test-device-id");
		});

		it("does not store device ID when rememberDevice is false", async () => {
			const mockDevice = createMockDevice();
			mockBluetooth.requestDevice.mockResolvedValue(mockDevice);

			const mockStorage = {
				get: vi.fn().mockReturnValue(null),
				set: vi.fn(),
				remove: vi.fn(),
			};

			const adapter = createWebBluetoothAdapter({ storage: mockStorage });
			await adapter.connect({ rememberDevice: false });

			expect(mockStorage.set).not.toHaveBeenCalled();
		});

		it("rejects with AbortError when signal is already aborted", async () => {
			const controller = new AbortController();
			controller.abort();

			const adapter = createWebBluetoothAdapter();
			await expect(
				adapter.connect({ signal: controller.signal }),
			).rejects.toThrow(AbortError);
			expect(mockBluetooth.requestDevice).not.toHaveBeenCalled();
		});

		it("rejects with AbortError when aborted during device request", async () => {
			const controller = new AbortController();

			mockBluetooth.requestDevice.mockImplementation(() => {
				return new Promise((_, reject) => {
					controller.signal.addEventListener("abort", () => {
						reject(new DOMException("Aborted", "AbortError"));
					});
				});
			});

			const adapter = createWebBluetoothAdapter();
			const connectPromise = adapter.connect({ signal: controller.signal });

			// Abort after starting
			setTimeout(() => controller.abort(), 10);

			await expect(connectPromise).rejects.toThrow();
		});

		it("uses custom connection timeout", async () => {
			const mockDevice = createMockDevice();
			// Make connect hang forever
			mockDevice.gatt?.connect.mockImplementation(() => new Promise(() => {}));
			mockBluetooth.requestDevice.mockResolvedValue(mockDevice);

			const adapter = createWebBluetoothAdapter({ connectionTimeoutMs: 50 });
			await expect(adapter.connect()).rejects.toThrow(/timed out/);
		});
	});

	describe("reconnect", () => {
		it("returns null when getDevices is not available", async () => {
			mockBluetooth.getDevices = undefined as unknown as ReturnType<
				typeof vi.fn
			>;

			const adapter = createWebBluetoothAdapter();
			const result = await adapter.reconnect?.();

			expect(result).toBeNull();
		});

		it("returns null when no devices available", async () => {
			mockBluetooth.getDevices.mockResolvedValue([]);

			const adapter = createWebBluetoothAdapter();
			const result = await adapter.reconnect?.();

			expect(result).toBeNull();
		});

		it("reconnects to remembered device by ID", async () => {
			const mockDevice = createMockDevice({ id: "remembered-id" });
			mockBluetooth.getDevices.mockResolvedValue([mockDevice]);

			const mockStorage = {
				get: vi.fn().mockReturnValue("remembered-id"),
				set: vi.fn(),
				remove: vi.fn(),
			};

			const adapter = createWebBluetoothAdapter({ storage: mockStorage });
			const session = await adapter.reconnect?.();

			expect(session).not.toBeNull();
			expect(session?.deviceId).toBe("remembered-id");
		});

		it("reconnects to device matching name prefix", async () => {
			const mockDevice = createMockDevice({
				id: "other-id",
				name: "WalkingPad A1",
			});
			mockBluetooth.getDevices.mockResolvedValue([mockDevice]);

			const mockStorage = {
				get: vi.fn().mockReturnValue(null),
				set: vi.fn(),
				remove: vi.fn(),
			};

			const adapter = createWebBluetoothAdapter({
				storage: mockStorage,
				namePrefixes: ["WalkingPad"],
			});
			const session = await adapter.reconnect?.();

			expect(session).not.toBeNull();
			expect(session?.deviceId).toBe("other-id");
		});

		it("returns null when connection fails", async () => {
			const mockDevice = createMockDevice();
			mockDevice.gatt?.connect.mockRejectedValue(
				new Error("Connection failed"),
			);
			mockBluetooth.getDevices.mockResolvedValue([mockDevice]);

			const consoleWarnSpy = vi
				.spyOn(console, "warn")
				.mockImplementation(() => {});

			const mockStorage = {
				get: vi.fn().mockReturnValue("test-device-id"),
				set: vi.fn(),
				remove: vi.fn(),
			};

			const adapter = createWebBluetoothAdapter({ storage: mockStorage });
			const result = await adapter.reconnect?.();

			expect(result).toBeNull();
			expect(consoleWarnSpy).toHaveBeenCalled();

			consoleWarnSpy.mockRestore();
		});

		it("returns null when device has no GATT", async () => {
			const mockDevice = createMockDevice();
			mockDevice.gatt = undefined;
			mockBluetooth.getDevices.mockResolvedValue([mockDevice]);

			const mockStorage = {
				get: vi.fn().mockReturnValue("test-device-id"),
				set: vi.fn(),
				remove: vi.fn(),
			};

			const adapter = createWebBluetoothAdapter({ storage: mockStorage });
			const result = await adapter.reconnect?.();

			expect(result).toBeNull();
		});
	});

	describe("forgetDevice", () => {
		it("removes device from storage", () => {
			const mockStorage = {
				get: vi.fn(),
				set: vi.fn(),
				remove: vi.fn(),
			};

			const adapter = createWebBluetoothAdapter({ storage: mockStorage });
			adapter.forgetDevice?.();

			expect(mockStorage.remove).toHaveBeenCalled();
		});
	});

	describe("getAvailability", () => {
		it("returns true when Bluetooth is available", async () => {
			mockBluetooth.getAvailability.mockResolvedValue(true);

			const adapter = createWebBluetoothAdapter();
			const result = await adapter.getAvailability?.();

			expect(result).toBe(true);
		});

		it("returns false when Bluetooth is not available", async () => {
			mockBluetooth.getAvailability.mockResolvedValue(false);

			const adapter = createWebBluetoothAdapter();
			const result = await adapter.getAvailability?.();

			expect(result).toBe(false);
		});

		it("returns true when getAvailability is not supported", async () => {
			mockBluetooth.getAvailability = undefined as unknown as ReturnType<
				typeof vi.fn
			>;

			const adapter = createWebBluetoothAdapter();
			const result = await adapter.getAvailability?.();

			expect(result).toBe(true);
		});

		it("returns false when Web Bluetooth is not available", async () => {
			Object.defineProperty(globalThis, "navigator", {
				value: {},
				writable: true,
				configurable: true,
			});

			const adapter = createWebBluetoothAdapter();
			const result = await adapter.getAvailability?.();

			expect(result).toBe(false);
		});
	});

	describe("session", () => {
		it("provides getPrimaryServices", async () => {
			const mockService = {
				uuid: "test-service-uuid",
				getCharacteristics: vi.fn().mockResolvedValue([]),
				getCharacteristic: vi.fn(),
			};

			const mockDevice = createMockDevice();
			mockDevice.gatt?.getPrimaryServices.mockResolvedValue([mockService]);
			mockBluetooth.requestDevice.mockResolvedValue(mockDevice);

			const adapter = createWebBluetoothAdapter();
			const session = await adapter.connect();
			const services = await session.getPrimaryServices();

			expect(services).toHaveLength(1);
			expect(services[0]?.uuid).toBe("test-service-uuid");
		});

		it("provides disconnect", async () => {
			const mockDevice = createMockDevice();
			mockBluetooth.requestDevice.mockResolvedValue(mockDevice);

			const adapter = createWebBluetoothAdapter();
			const session = await adapter.connect();
			await session.disconnect();

			expect(mockDevice.gatt?.disconnect).toHaveBeenCalled();
		});

		it("provides onDisconnect callback", async () => {
			const mockDevice = createMockDevice();
			mockBluetooth.requestDevice.mockResolvedValue(mockDevice);

			const adapter = createWebBluetoothAdapter();
			const session = await adapter.connect();

			const callback = vi.fn();
			const unsubscribe = session.onDisconnect?.(callback);

			expect(mockDevice.addEventListener).toHaveBeenCalledWith(
				"gattserverdisconnected",
				expect.any(Function),
			);

			unsubscribe?.();
			expect(mockDevice.removeEventListener).toHaveBeenCalledWith(
				"gattserverdisconnected",
				expect.any(Function),
			);
		});
	});

	describe("buildRequestOptions", () => {
		it("uses name prefixes as filters when no filters provided", async () => {
			const mockDevice = createMockDevice();
			mockBluetooth.requestDevice.mockResolvedValue(mockDevice);

			const adapter = createWebBluetoothAdapter({
				namePrefixes: ["Test", "Device"],
			});
			await adapter.connect();

			expect(mockBluetooth.requestDevice).toHaveBeenCalledWith(
				expect.objectContaining({
					filters: [{ namePrefix: "Test" }, { namePrefix: "Device" }],
				}),
			);
		});

		it("uses acceptAllDevices when no filters or prefixes", async () => {
			const mockDevice = createMockDevice();
			mockBluetooth.requestDevice.mockResolvedValue(mockDevice);

			const adapter = createWebBluetoothAdapter();
			await adapter.connect();

			expect(mockBluetooth.requestDevice).toHaveBeenCalledWith(
				expect.objectContaining({
					acceptAllDevices: true,
				}),
			);
		});

		it("converts numeric service UUIDs to full format", async () => {
			const mockDevice = createMockDevice();
			mockBluetooth.requestDevice.mockResolvedValue(mockDevice);

			const adapter = createWebBluetoothAdapter({
				optionalServices: [0x1826, "custom-service"],
			});
			await adapter.connect();

			expect(mockBluetooth.requestDevice).toHaveBeenCalledWith(
				expect.objectContaining({
					optionalServices: [
						`00001826${BLUETOOTH_UUID_BASE}`,
						"custom-service",
					],
				}),
			);
		});
	});
});

describe("Web Bluetooth not available", () => {
	it("throws when navigator.bluetooth is undefined", async () => {
		const originalNavigator = globalThis.navigator;
		Object.defineProperty(globalThis, "navigator", {
			value: {},
			writable: true,
			configurable: true,
		});

		const adapter = createWebBluetoothAdapter();
		await expect(adapter.connect()).rejects.toThrow(
			"Web Bluetooth not available",
		);

		Object.defineProperty(globalThis, "navigator", {
			value: originalNavigator,
			writable: true,
			configurable: true,
		});
	});
});
