/**
 * End-to-End BLE Scenario Tests
 *
 * These tests simulate realistic BLE usage patterns and verify
 * the library behaves correctly in complex, real-world scenarios.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPollManager } from "../../async";
import {
	createConnectionPool,
	readWithTimeout,
	startNotifications,
	withRetry,
	writeWithTimeout,
} from "../../ble";
import {
	AbortError,
	isTransientBLEError,
	raceWithAbort,
	TimeoutError,
} from "../../errors";
import { createEventEmitter, createStateMachine } from "../../state";
import type {
	BLEAdapter,
	BLEConnectedSession,
	BLEGATTCharacteristic,
	BLEGATTService,
} from "../../types";

// =============================================================================
// Mock Factories
// =============================================================================

function createMockCharacteristic(
	options: {
		uuid?: string;
		canNotify?: boolean;
		readValue?: Uint8Array;
		writeDelay?: number;
		readDelay?: number;
		failOnWrite?: boolean;
		failOnRead?: boolean;
	} = {},
): BLEGATTCharacteristic {
	const listeners = new Map<string, Set<EventListener>>();

	return {
		uuid: options.uuid ?? "test-char-uuid",
		properties: {
			notify: options.canNotify ?? true,
			read: true,
			write: true,
			writeWithoutResponse: false,
			broadcast: false,
			indicate: false,
			authenticatedSignedWrites: false,
			reliableWrite: false,
			writableAuxiliaries: false,
		},
		value: options.readValue
			? new DataView(options.readValue.buffer)
			: undefined,
		readValue: vi.fn().mockImplementation(async () => {
			if (options.readDelay) {
				await new Promise((r) => setTimeout(r, options.readDelay));
			}
			if (options.failOnRead) {
				throw new Error("GATT read failed");
			}
			return new DataView(options.readValue?.buffer ?? new ArrayBuffer(4));
		}),
		writeValueWithResponse: vi.fn().mockImplementation(async () => {
			if (options.writeDelay) {
				await new Promise((r) => setTimeout(r, options.writeDelay));
			}
			if (options.failOnWrite) {
				throw new Error("GATT write failed");
			}
		}),
		writeValueWithoutResponse: vi.fn().mockResolvedValue(undefined),
		startNotifications: vi.fn().mockResolvedValue(undefined),
		stopNotifications: vi.fn().mockResolvedValue(undefined),
		getDescriptor: vi.fn(),
		getDescriptors: vi.fn().mockResolvedValue([]),
		addEventListener: vi.fn((type, listener) => {
			if (!listeners.has(type)) {
				listeners.set(type, new Set());
			}
			listeners.get(type)?.add(listener as EventListener);
		}),
		removeEventListener: vi.fn((type, listener) => {
			listeners.get(type)?.delete(listener as EventListener);
		}),
		// Helper to simulate notification
		_emit: (type: string, value: Uint8Array) => {
			const event = {
				target: {
					value: new DataView(value.buffer),
				},
			} as unknown as Event;
			listeners.get(type)?.forEach((l) => {
				l(event);
			});
		},
	} as BLEGATTCharacteristic & {
		_emit: (type: string, value: Uint8Array) => void;
	};
}

function createMockService(
	characteristics: BLEGATTCharacteristic[],
): BLEGATTService {
	return {
		uuid: "test-service-uuid",
		getCharacteristic: vi.fn().mockImplementation(async (uuid: string) => {
			return characteristics.find((c) => c.uuid === uuid) ?? null;
		}),
		getCharacteristics: vi.fn().mockResolvedValue(characteristics),
	};
}

function createMockSession(
	options: {
		deviceId?: string;
		services?: BLEGATTService[];
		disconnectDelay?: number;
		failOnDisconnect?: boolean;
	} = {},
): BLEConnectedSession & { _triggerDisconnect: () => void } {
	const disconnectCallbacks: (() => void)[] = [];

	return {
		deviceId: options.deviceId ?? "test-device",
		deviceName: "Test Device",
		getPrimaryServices: vi.fn().mockResolvedValue(options.services ?? []),
		getPrimaryService: vi.fn().mockImplementation(async (uuid: string) => {
			return options.services?.find((s) => s.uuid === uuid) ?? null;
		}),
		disconnect: vi.fn().mockImplementation(async () => {
			if (options.disconnectDelay) {
				await new Promise((r) => setTimeout(r, options.disconnectDelay));
			}
			if (options.failOnDisconnect) {
				throw new Error("Disconnect failed");
			}
		}),
		onDisconnect: vi.fn((callback: () => void) => {
			disconnectCallbacks.push(callback);
			return () => {
				const idx = disconnectCallbacks.indexOf(callback);
				if (idx >= 0) disconnectCallbacks.splice(idx, 1);
			};
		}),
		_triggerDisconnect: () => {
			disconnectCallbacks.forEach((cb) => {
				cb();
			});
		},
	};
}

function createMockAdapter(session: BLEConnectedSession): BLEAdapter {
	return {
		connect: vi.fn().mockResolvedValue(session),
		reconnect: vi.fn().mockResolvedValue(session),
		forgetDevice: vi.fn(),
	};
}

// =============================================================================
// E2E Scenario Tests
// =============================================================================

describe("E2E: Device Discovery and Connection", () => {
	it("complete connection lifecycle: connect -> use -> disconnect", async () => {
		const char = createMockCharacteristic({
			readValue: new Uint8Array([0x01, 0x02]),
		});
		const mockService = createMockService([char]);
		const session = createMockSession({ services: [mockService] });

		const pool = createConnectionPool({
			createAdapter: () => createMockAdapter(session),
		});

		// Connect
		const connectedSession = await pool.connect();
		expect(pool.connectionCount).toBe(1);

		// Get service and characteristic
		const services = await connectedSession.getPrimaryServices();
		expect(services).toHaveLength(1);

		const service = services[0];
		if (!service) {
			throw new Error("Expected service to exist");
		}
		const characteristics = await service.getCharacteristics();
		expect(characteristics).toHaveLength(1);

		// Read value
		const characteristic = characteristics[0];
		if (!characteristic) {
			throw new Error("Expected characteristic to exist");
		}
		const value = await characteristic.readValue();
		expect(new Uint8Array(value.buffer)).toEqual(new Uint8Array([0x01, 0x02]));

		// Disconnect
		await pool.disconnect(connectedSession.deviceId);
		expect(pool.connectionCount).toBe(0);
	});

	it("handles unexpected disconnect during operation", async () => {
		const char = createMockCharacteristic({
			readDelay: 100, // Slow read
		});
		const service = createMockService([char]);
		const session = createMockSession({ services: [service] });

		const pool = createConnectionPool({
			createAdapter: () => createMockAdapter(session),
		});

		const onDisconnect = vi.fn();
		pool.onDisconnect(onDisconnect);

		await pool.connect();

		// Start a slow read
		const readPromise = char.readValue();

		// Simulate unexpected disconnect during read
		(session as ReturnType<typeof createMockSession>)._triggerDisconnect();

		// Read should still complete (BLE limitation)
		await readPromise;

		// Pool should reflect disconnected state
		expect(pool.connectionCount).toBe(0);
		expect(onDisconnect).toHaveBeenCalledWith("test-device");
	});

	it("manages multiple concurrent devices", async () => {
		let deviceCounter = 0;

		const pool = createConnectionPool({
			maxConnections: 3,
			createAdapter: () => {
				const id = `device-${++deviceCounter}`;
				const session = createMockSession({ deviceId: id });
				return createMockAdapter(session);
			},
		});

		// Connect to 3 devices
		const sessions = await Promise.all([
			pool.connect(),
			pool.connect(),
			pool.connect(),
		]);

		expect(pool.connectionCount).toBe(3);
		expect(sessions.map((s) => s.deviceId)).toEqual([
			"device-1",
			"device-2",
			"device-3",
		]);

		// Fourth connection should fail
		await expect(pool.connect()).rejects.toThrow(/Maximum connections/);

		// Disconnect one device
		await pool.disconnect("device-2");
		expect(pool.connectionCount).toBe(2);

		// Now we can connect again
		const newSession = await pool.connect();
		expect(newSession.deviceId).toBe("device-4");
		expect(pool.connectionCount).toBe(3);

		// Cleanup
		await pool.disconnectAll();
		expect(pool.connectionCount).toBe(0);
	});
});

describe("E2E: Notifications Lifecycle", () => {
	it("subscribes, receives data, and unsubscribes correctly", async () => {
		const char = createMockCharacteristic({
			canNotify: true,
		}) as BLEGATTCharacteristic & {
			_emit: (type: string, value: Uint8Array) => void;
		};

		const receivedData: ArrayBuffer[] = [];
		const cleanup = await startNotifications(char, (data) => {
			receivedData.push(data);
		});

		// Simulate incoming notifications
		char._emit("characteristicvaluechanged", new Uint8Array([0x01]));
		char._emit("characteristicvaluechanged", new Uint8Array([0x02, 0x03]));
		char._emit(
			"characteristicvaluechanged",
			new Uint8Array([0x04, 0x05, 0x06]),
		);

		expect(receivedData).toHaveLength(3);

		// Cleanup
		cleanup();

		// Verify stopNotifications was called
		expect(char.stopNotifications).toHaveBeenCalled();

		// Subsequent notifications should not be received
		char._emit("characteristicvaluechanged", new Uint8Array([0xff]));
		expect(receivedData).toHaveLength(3); // Still 3
	});

	it("cleanup is idempotent", async () => {
		const char = createMockCharacteristic({ canNotify: true });

		const cleanup = await startNotifications(char, vi.fn());

		// Call cleanup multiple times
		cleanup();
		cleanup();
		cleanup();

		// stopNotifications should only be called once
		expect(char.stopNotifications).toHaveBeenCalledTimes(1);
	});

	it("handles abort signal during notification setup", async () => {
		const char = createMockCharacteristic({ canNotify: true });
		const controller = new AbortController();
		controller.abort();

		await expect(
			startNotifications(char, vi.fn(), { signal: controller.signal }),
		).rejects.toThrow(AbortError);

		// Should not have started notifications
		expect(char.startNotifications).not.toHaveBeenCalled();
	});
});

describe("E2E: Write Operations with Retry", () => {
	it("retries transient failures and eventually succeeds", async () => {
		let attempts = 0;
		const char = createMockCharacteristic();
		char.writeValueWithResponse = vi.fn().mockImplementation(async () => {
			attempts++;
			if (attempts < 3) {
				throw new Error("GATT operation failed");
			}
		});

		await withRetry(
			() => writeWithTimeout(char, new Uint8Array([0x01]), { timeoutMs: 1000 }),
			{ maxAttempts: 5, initialDelayMs: 10, jitter: false },
		);

		expect(attempts).toBe(3);
	});

	it("does not retry non-retryable errors", async () => {
		let attempts = 0;
		const char = createMockCharacteristic();
		char.writeValueWithResponse = vi.fn().mockImplementation(async () => {
			attempts++;
			throw new Error("User cancelled the request");
		});

		await expect(
			withRetry(
				() =>
					writeWithTimeout(char, new Uint8Array([0x01]), { timeoutMs: 1000 }),
				{ maxAttempts: 5, initialDelayMs: 10 },
			),
		).rejects.toThrow("User cancelled");

		expect(attempts).toBe(1);
	});

	it("respects abort signal during retry", async () => {
		const char = createMockCharacteristic();
		char.writeValueWithResponse = vi
			.fn()
			.mockRejectedValue(new Error("Network error"));

		const controller = new AbortController();

		const promise = withRetry(
			() => writeWithTimeout(char, new Uint8Array([0x01]), { timeoutMs: 1000 }),
			{ maxAttempts: 10, initialDelayMs: 50, signal: controller.signal },
		);

		// Abort after a short delay
		setTimeout(() => controller.abort(), 30);

		await expect(promise).rejects.toThrow(AbortError);
	});
});

describe("E2E: Polling Device State", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("polls device and handles errors gracefully", async () => {
		const pollResults: number[] = [];
		let pollCount = 0;

		const pollManager = createPollManager<{ id: string }>(
			async (_context) => {
				pollCount++;
				if (pollCount === 3) {
					throw new Error("Temporary network error");
				}
				pollResults.push(pollCount);
			},
			{
				defaultIntervalMs: 100,
				onError: vi.fn(),
				maxConsecutiveErrors: 3,
			},
		);

		pollManager.start({ id: "test-device" });

		// Poll 1
		await vi.advanceTimersByTimeAsync(100);
		expect(pollResults).toEqual([1]);

		// Poll 2
		await vi.advanceTimersByTimeAsync(100);
		expect(pollResults).toEqual([1, 2]);

		// Poll 3 - fails
		await vi.advanceTimersByTimeAsync(100);
		expect(pollResults).toEqual([1, 2]); // No new result

		// Poll 4 - should still work (only 1 error)
		await vi.advanceTimersByTimeAsync(100);
		expect(pollResults).toEqual([1, 2, 4]);

		pollManager.stop();
		expect(pollManager.isPolling()).toBe(false);
	});

	it("stops polling after max consecutive errors", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		let pollCount = 0;
		const onError = vi.fn();

		const pollManager = createPollManager<{ id: string }>(
			async () => {
				pollCount++;
				throw new Error("Persistent error");
			},
			{
				defaultIntervalMs: 100,
				onError,
				maxConsecutiveErrors: 3,
			},
		);

		pollManager.start({ id: "test-device" });

		// 3 consecutive errors
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);

		expect(pollCount).toBe(3);
		expect(onError).toHaveBeenCalledTimes(3);
		expect(pollManager.isPolling()).toBe(false);

		warnSpy.mockRestore();
	});
});

describe("E2E: State Machine Transitions", () => {
	it("handles complete connection state lifecycle", () => {
		const sm = createStateMachine("disconnected");
		const transitions: string[] = [];

		sm.onTransition((from, to) => {
			transitions.push(`${from}->${to}`);
		});

		// Connect flow
		sm.transition("connecting");
		sm.transition("connected");

		// Disconnect flow
		sm.transition("disconnected");

		expect(transitions).toEqual([
			"disconnected->connecting",
			"connecting->connected",
			"connected->disconnected",
		]);
	});

	it("handles error recovery flow", () => {
		const sm = createStateMachine("disconnected");
		const transitions: string[] = [];

		sm.onTransition((from, to) => {
			transitions.push(`${from}->${to}`);
		});

		// Connect attempt fails
		sm.transition("connecting");
		sm.transition("error");

		// Retry
		sm.transition("connecting");
		sm.transition("connected");

		// Later disconnect
		sm.transition("disconnected");

		expect(transitions).toEqual([
			"disconnected->connecting",
			"connecting->error",
			"error->connecting",
			"connecting->connected",
			"connected->disconnected",
		]);
	});
});

describe("E2E: Event Emitter Stress Test", () => {
	it("handles rapid subscribe/unsubscribe cycles", () => {
		const emitter = createEventEmitter<{ data: number }>();
		const receivedValues: number[] = [];

		for (let i = 0; i < 100; i++) {
			const unsub = emitter.on("data", (val) => {
				receivedValues.push(val);
			});

			emitter.emit("data", i);
			unsub();

			// Verify no more events received after unsubscribe
			emitter.emit("data", -1);
		}

		// Should have received exactly 100 values (one per subscription)
		expect(receivedValues.filter((v) => v >= 0)).toHaveLength(100);
		// And no -1 values (those were emitted after unsubscribe)
		expect(receivedValues.filter((v) => v === -1)).toHaveLength(0);
	});

	it("handles many concurrent listeners", () => {
		const emitter = createEventEmitter<{ data: number }>();
		const results: number[] = [];

		// Add 1000 listeners
		const unsubscribes = Array.from({ length: 1000 }, (_, i) =>
			emitter.on("data", (val) => {
				results.push(val + i);
			}),
		);

		emitter.emit("data", 1);

		// All 1000 listeners should have been called
		expect(results).toHaveLength(1000);

		// Cleanup
		unsubscribes.forEach((unsub) => {
			unsub();
		});
		expect(emitter.listenerCount("data")).toBe(0);
	});
});

describe("E2E: Timeout and Race Conditions", () => {
	it("handles timeout during slow BLE operation", async () => {
		const char = createMockCharacteristic({ readDelay: 5000 });

		await expect(readWithTimeout(char, { timeoutMs: 100 })).rejects.toThrow(
			TimeoutError,
		);
	});

	it("handles abort winning race against completion", async () => {
		const slowPromise = new Promise<string>((resolve) => {
			setTimeout(() => resolve("completed"), 1000);
		});

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);

		await expect(raceWithAbort(slowPromise, controller.signal)).rejects.toThrow(
			AbortError,
		);
	});

	it("handles completion winning race against abort", async () => {
		const fastPromise = new Promise<string>((resolve) => {
			setTimeout(() => resolve("completed"), 10);
		});

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 1000);

		const result = await raceWithAbort(fastPromise, controller.signal);
		expect(result).toBe("completed");
	});
});

describe("E2E: isTransientBLEError classification", () => {
	const testCases = [
		// Non-retryable
		{ message: "User cancelled the request", expected: false },
		{ message: "User denied access", expected: false },
		{ message: "Device not found", expected: false },
		{ message: "No device selected", expected: false },
		{ message: "Permission denied", expected: false },

		// Retryable
		{ message: "Network error occurred", expected: true },
		{ message: "GATT operation failed", expected: true },
		{ message: "Connection timed out", expected: true },
		{ message: "Device disconnected", expected: true },
		{ message: "Failed to execute operation", expected: true },
		{ message: "Not connected to device", expected: true },
	];

	testCases.forEach(({ message, expected }) => {
		it(`classifies "${message}" as ${expected ? "retryable" : "non-retryable"}`, () => {
			expect(isTransientBLEError(new Error(message))).toBe(expected);
		});
	});
});
