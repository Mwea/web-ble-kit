/**
 * TDD tests for QA findings
 * These tests are written FIRST to expose bugs, then code is fixed to pass them.
 *
 * Covers:
 * - C-003: EventListenerObject in toEventTarget
 * - H-001: UUID matching for short IDs
 * - H-002: Checked buffer read variants
 * - H-004: Abort signal in startNotifications
 * - H-005: State machine re-entrancy guard
 * - M-001: Concurrent connect at max capacity
 * - M-002: disconnectAll partial failures
 * - M-008: removeAllListeners with event clears onceWrappers
 */
import { describe, expect, it, vi } from "vitest";
import { createConnectionPool, startNotifications } from "../../ble";
import { AbortError } from "../../errors";
import {
	createEventEmitter,
	createStateMachine,
	toEventTarget,
} from "../../state";
import type {
	BLEAdapter,
	BLEConnectedSession,
	BLEGATTCharacteristic,
} from "../../types";
import {
	readByteChecked,
	readUint16LEChecked,
	readUint24LEChecked,
	uuidMatches,
} from "../../utils";

// =============================================================================
// C-003: EventListenerObject in toEventTarget
// =============================================================================
describe("C-003: toEventTarget EventListenerObject support", () => {
	interface TestEvents extends Record<string, unknown> {
		message: string;
	}

	it("supports EventListenerObject with handleEvent method", () => {
		const emitter = createEventEmitter<TestEvents>();
		const target = toEventTarget(emitter);

		const listenerObject = {
			handleEvent: vi.fn(),
		};

		target.addEventListener("message", listenerObject);
		emitter.emit("message", "hello");

		expect(listenerObject.handleEvent).toHaveBeenCalled();
		expect(listenerObject.handleEvent).toHaveBeenCalledWith(
			expect.objectContaining({ detail: "hello" }),
		);
	});

	it("removes EventListenerObject correctly", () => {
		const emitter = createEventEmitter<TestEvents>();
		const target = toEventTarget(emitter);

		const listenerObject = {
			handleEvent: vi.fn(),
		};

		target.addEventListener("message", listenerObject);
		target.removeEventListener("message", listenerObject);

		emitter.emit("message", "hello");

		expect(listenerObject.handleEvent).not.toHaveBeenCalled();
	});

	it("deduplicates EventListenerObject like native EventTarget", () => {
		const emitter = createEventEmitter<TestEvents>();
		const target = toEventTarget(emitter);

		const listenerObject = {
			handleEvent: vi.fn(),
		};

		// Add same listener twice
		target.addEventListener("message", listenerObject);
		target.addEventListener("message", listenerObject);

		emitter.emit("message", "hello");

		// Should only be called once (deduplication)
		expect(listenerObject.handleEvent).toHaveBeenCalledTimes(1);
	});
});

// =============================================================================
// H-001: UUID matching for short IDs
// =============================================================================
describe("H-001: uuidMatches with various short ID lengths", () => {
	it("matches 4-character short ID", () => {
		const fullUuid = "0000fe00-0000-1000-8000-00805f9b34fb";
		expect(uuidMatches(fullUuid, "fe00")).toBe(true);
	});

	it("matches 2-character short ID", () => {
		// Short ID "01" becomes "00000001-..." in full UUID
		const fullUuid = "00000001-0000-1000-8000-00805f9b34fb";
		expect(uuidMatches(fullUuid, "01")).toBe(true);
	});

	it("matches 1-character short ID", () => {
		const fullUuid = "00000001-0000-1000-8000-00805f9b34fb";
		expect(uuidMatches(fullUuid, "1")).toBe(true);
	});

	it("matches 3-character short ID", () => {
		const fullUuid = "00000123-0000-1000-8000-00805f9b34fb";
		expect(uuidMatches(fullUuid, "123")).toBe(true);
	});

	it("handles case insensitivity for short IDs", () => {
		const fullUuid = "0000fe00-0000-1000-8000-00805f9b34fb";
		expect(uuidMatches(fullUuid, "FE00")).toBe(true);
		expect(uuidMatches(fullUuid, "Fe00")).toBe(true);
	});

	it("direct short UUID comparison works", () => {
		expect(uuidMatches("fe00", "fe00")).toBe(true);
		expect(uuidMatches("1", "1")).toBe(true);
		expect(uuidMatches("01", "1")).toBe(true); // Padded comparison
	});
});

// =============================================================================
// H-002: Checked buffer read variants
// =============================================================================
describe("H-002: Checked buffer read variants", () => {
	const testData = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);

	describe("readByteChecked", () => {
		it("returns value for valid offset", () => {
			expect(readByteChecked(testData, 0)).toBe(0x01);
			expect(readByteChecked(testData, 4)).toBe(0x05);
		});

		it("returns undefined for negative offset", () => {
			expect(readByteChecked(testData, -1)).toBeUndefined();
		});

		it("returns undefined for offset beyond length", () => {
			expect(readByteChecked(testData, 5)).toBeUndefined();
			expect(readByteChecked(testData, 100)).toBeUndefined();
		});

		it("distinguishes zero value from invalid offset", () => {
			const dataWithZero = new Uint8Array([0x00, 0x01]);
			expect(readByteChecked(dataWithZero, 0)).toBe(0); // Actual zero
			expect(readByteChecked(dataWithZero, 10)).toBeUndefined(); // Invalid
		});
	});

	describe("readUint16LEChecked", () => {
		it("returns value for valid offset", () => {
			// 0x01, 0x02 in LE = 0x0201
			expect(readUint16LEChecked(testData, 0)).toBe(0x0201);
		});

		it("returns undefined when not enough bytes", () => {
			expect(readUint16LEChecked(testData, 4)).toBeUndefined(); // Only 1 byte left
			expect(readUint16LEChecked(testData, 5)).toBeUndefined(); // Past end
		});

		it("returns undefined for negative offset", () => {
			expect(readUint16LEChecked(testData, -1)).toBeUndefined();
		});
	});

	describe("readUint24LEChecked", () => {
		it("returns value for valid offset", () => {
			// 0x01, 0x02, 0x03 in LE = 0x030201
			expect(readUint24LEChecked(testData, 0)).toBe(0x030201);
		});

		it("returns undefined when not enough bytes", () => {
			expect(readUint24LEChecked(testData, 3)).toBeUndefined(); // Only 2 bytes left
			expect(readUint24LEChecked(testData, 4)).toBeUndefined(); // Only 1 byte left
		});

		it("returns undefined for negative offset", () => {
			expect(readUint24LEChecked(testData, -1)).toBeUndefined();
		});
	});
});

// =============================================================================
// H-004: Abort signal in startNotifications
// =============================================================================
describe("H-004: startNotifications abort signal", () => {
	function createMockCharacteristic(): BLEGATTCharacteristic {
		return {
			uuid: "test-char",
			properties: {
				notify: true,
				read: false,
				write: false,
				writeWithoutResponse: false,
				broadcast: false,
				indicate: false,
				authenticatedSignedWrites: false,
				reliableWrite: false,
				writableAuxiliaries: false,
			},
			readValue: vi.fn(),
			writeValueWithResponse: vi.fn(),
			writeValueWithoutResponse: vi.fn(),
			startNotifications: vi.fn().mockResolvedValue(undefined),
			stopNotifications: vi.fn().mockResolvedValue(undefined),
			getDescriptor: vi.fn(),
			getDescriptors: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			get value() {
				return undefined;
			},
		};
	}

	it("rejects with AbortError when signal already aborted", async () => {
		const char = createMockCharacteristic();
		const controller = new AbortController();
		controller.abort();

		await expect(
			startNotifications(char, vi.fn(), { signal: controller.signal }),
		).rejects.toThrow(AbortError);

		expect(char.startNotifications).not.toHaveBeenCalled();
	});

	it("rejects with AbortError when aborted during setup", async () => {
		const char = createMockCharacteristic();
		const controller = new AbortController();

		// Make startNotifications hang until aborted
		char.startNotifications = vi.fn().mockImplementation(() => {
			return new Promise((_, reject) => {
				controller.signal.addEventListener("abort", () => {
					reject(new DOMException("Aborted", "AbortError"));
				});
			});
		});

		const promise = startNotifications(char, vi.fn(), {
			signal: controller.signal,
		});

		// Abort after starting
		setTimeout(() => controller.abort(), 10);

		await expect(promise).rejects.toThrow();
	});

	it("does not set up listener when aborted", async () => {
		const char = createMockCharacteristic();
		const controller = new AbortController();
		controller.abort();

		try {
			await startNotifications(char, vi.fn(), { signal: controller.signal });
		} catch {
			// Expected
		}

		expect(char.addEventListener).not.toHaveBeenCalled();
	});
});

// =============================================================================
// H-005: State machine re-entrancy guard
// =============================================================================
describe("H-005: State machine re-entrancy protection", () => {
	it("prevents infinite transition loops", () => {
		const sm = createStateMachine("disconnected");
		let transitionCount = 0;

		sm.onTransition((_from, to) => {
			transitionCount++;
			if (transitionCount > 10) {
				throw new Error("Infinite loop detected in test");
			}

			// Try to trigger infinite loop: error -> connecting -> error -> ...
			if (to === "error") {
				try {
					sm.transition("connecting");
				} catch {
					// Expected: re-entrancy should be blocked
				}
			}
			if (to === "connecting") {
				try {
					sm.transition("error");
				} catch {
					// Expected: re-entrancy should be blocked
				}
			}
		});

		sm.transition("connecting");
		sm.transition("error");

		// Should not have gone into infinite loop
		expect(transitionCount).toBeLessThan(10);
	});

	it("throws when trying to transition during callback", () => {
		const sm = createStateMachine("disconnected");
		const errors: Error[] = [];

		sm.onTransition(() => {
			try {
				sm.transition("connected");
			} catch (e) {
				errors.push(e as Error);
			}
		});

		sm.transition("connecting");

		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain("transition");
	});
});

// =============================================================================
// M-001: Concurrent connect at max capacity
// =============================================================================
describe("M-001: ConnectionPool concurrent connect at max capacity", () => {
	it("handles concurrent connect calls at max capacity", async () => {
		let deviceCounter = 0;
		const createMockAdapter = (): BLEAdapter => ({
			connect: vi.fn().mockImplementation(async () => {
				deviceCounter++;
				await new Promise((r) => setTimeout(r, 10)); // Simulate async
				return {
					deviceId: `device-${deviceCounter}`,
					deviceName: `Device ${deviceCounter}`,
					getPrimaryServices: vi.fn().mockResolvedValue([]),
					getPrimaryService: vi.fn(),
					disconnect: vi.fn(),
					onDisconnect: vi.fn().mockReturnValue(() => {}),
					watchAdvertisements: vi.fn(),
					unwatchAdvertisements: vi.fn(),
					watchingAdvertisements: false,
					rssi: undefined,
					onAdvertisement: vi.fn().mockReturnValue(() => {}),
				} as BLEConnectedSession;
			}),
			forgetDevice: vi.fn(),
		});

		const pool = createConnectionPool({
			createAdapter: createMockAdapter,
			maxConnections: 2,
		});

		// Start 3 concurrent connects
		const results = await Promise.allSettled([
			pool.connect(),
			pool.connect(),
			pool.connect(),
		]);

		const successes = results.filter((r) => r.status === "fulfilled");
		const failures = results.filter((r) => r.status === "rejected");

		// At most 2 should succeed
		expect(successes.length).toBeLessThanOrEqual(2);
		// At least 1 should fail
		expect(failures.length).toBeGreaterThanOrEqual(1);

		await pool.disconnectAll();
	});
});

// =============================================================================
// M-002: disconnectAll partial failures
// =============================================================================
describe("M-002: ConnectionPool disconnectAll partial failures", () => {
	it("continues disconnecting when one fails", async () => {
		let deviceCounter = 0;
		const createMockAdapter = (): BLEAdapter => {
			return {
				connect: vi.fn().mockImplementation(async () => {
					deviceCounter++;
					const id = `device-${deviceCounter}`;
					return {
						deviceId: id,
						deviceName: `Device ${deviceCounter}`,
						getPrimaryServices: vi.fn().mockResolvedValue([]),
						getPrimaryService: vi.fn(),
						disconnect: vi.fn().mockImplementation(async () => {
							if (id === "device-2") {
								throw new Error("Disconnect failed");
							}
						}),
						onDisconnect: vi.fn().mockReturnValue(() => {}),
						watchAdvertisements: vi.fn(),
						unwatchAdvertisements: vi.fn(),
						watchingAdvertisements: false,
						rssi: undefined,
						onAdvertisement: vi.fn().mockReturnValue(() => {}),
					} as BLEConnectedSession;
				}),
				forgetDevice: vi.fn(),
			};
		};

		const pool = createConnectionPool({
			createAdapter: createMockAdapter,
			maxConnections: 3,
		});
		const consoleWarnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => {});

		// Connect 3 devices
		await pool.connect();
		await pool.connect();
		await pool.connect();

		// disconnectAll should not throw even if one fails
		await expect(pool.disconnectAll()).resolves.not.toThrow();

		// Should have logged the failure
		expect(consoleWarnSpy).toHaveBeenCalled();

		consoleWarnSpy.mockRestore();
	});
});

// =============================================================================
// M-008: removeAllListeners with event clears onceWrappers
// =============================================================================
describe("M-008: removeAllListeners(event) clears onceWrappers", () => {
	interface TestEvents extends Record<string, unknown> {
		message: string;
		count: number;
	}

	it("clears onceWrappers when removing all listeners for an event", () => {
		const emitter = createEventEmitter<TestEvents>();

		// Add once listener
		const callback = vi.fn();
		emitter.once("message", callback);

		// Remove all listeners for 'message' event
		emitter.removeAllListeners("message");

		// Emit should not call the callback
		emitter.emit("message", "hello");
		expect(callback).not.toHaveBeenCalled();

		// Listener count should be 0
		expect(emitter.listenerCount("message")).toBe(0);
	});

	it("once listener for different event still works after removeAllListeners(event)", () => {
		const emitter = createEventEmitter<TestEvents>();

		const messageCallback = vi.fn();
		const countCallback = vi.fn();

		emitter.once("message", messageCallback);
		emitter.once("count", countCallback);

		// Remove only message listeners
		emitter.removeAllListeners("message");

		// count listener should still work
		emitter.emit("count", 42);
		expect(countCallback).toHaveBeenCalledWith(42);

		// message listener should not be called
		emitter.emit("message", "hello");
		expect(messageCallback).not.toHaveBeenCalled();
	});
});

// =============================================================================
// L-002: Console warning prefix consistency (documentation test)
// =============================================================================
describe("L-002: Console warning prefixes", () => {
	it("documents expected prefix format: [web-ble-kit:module]", () => {
		// This is a documentation test - we're establishing the expected format
		const expectedPrefixPattern = /^\[web-ble-kit(:[a-z-]+)?\]/;

		// These are the prefixes we expect to see:
		const expectedPrefixes = [
			"[web-ble-kit]",
			"[web-ble-kit:poll-manager]",
			"[web-ble-kit:state-machine]",
			"[web-ble-kit:event-emitter]",
		];

		for (const prefix of expectedPrefixes) {
			expect(prefix).toMatch(expectedPrefixPattern);
		}
	});
});
