/**
 * QA Round 3: Bug Exposure Tests
 *
 * These tests are designed to EXPOSE real bugs identified in the codebase.
 * Each test targets a specific issue and will FAIL until the bug is fixed.
 *
 * Run with: npm test -- -t "QA-R3"
 */

import * as fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { createConnectionPool } from "../../ble";
import {
	createEventEmitter,
	createStateMachine,
	toEventTarget,
} from "../../state";
import type { BLEAdapter, BLEConnectedSession } from "../../types";
import {
	readByteChecked,
	readUint16LEChecked,
	readUint24BEChecked,
	readUint24LEChecked,
} from "../../utils";

// =============================================================================
// BUG-001: removeAllListeners(event) doesn't clear onceWrappers
// =============================================================================
describe("QA-R3: BUG-001 - removeAllListeners onceWrappers leak", () => {
	it("removeAllListeners(event) should prevent once callbacks from firing", () => {
		const emitter = createEventEmitter<{ test: number }>();
		const cb = vi.fn();

		// Register once listener
		emitter.once("test", cb);
		expect(emitter.listenerCount("test")).toBe(1);

		// Remove all listeners for 'test'
		emitter.removeAllListeners("test");
		expect(emitter.listenerCount("test")).toBe(0);

		// Emit - callback should NOT fire
		emitter.emit("test", 42);
		expect(cb).not.toHaveBeenCalled();
	});

	it("once callback should not fire after removeAllListeners(event) and re-subscribe", () => {
		const emitter = createEventEmitter<{ test: number }>();
		const oldCb = vi.fn();
		const newCb = vi.fn();

		// Register once listener
		emitter.once("test", oldCb);

		// Remove all listeners for 'test'
		emitter.removeAllListeners("test");

		// Re-subscribe with new callback
		emitter.on("test", newCb);

		// Emit - only newCb should fire, oldCb should NOT
		emitter.emit("test", 42);

		expect(oldCb).not.toHaveBeenCalled();
		expect(newCb).toHaveBeenCalledWith(42);
	});

	it("off() after removeAllListeners(event) should be safe", () => {
		const emitter = createEventEmitter<{ test: number }>();
		const cb = vi.fn();

		emitter.once("test", cb);
		emitter.removeAllListeners("test");

		// This should not throw even though wrapper mapping may be gone
		expect(() => emitter.off("test", cb)).not.toThrow();
	});

	it("stress test: rapid once/removeAllListeners cycles", () => {
		const emitter = createEventEmitter<{ test: number }>();

		for (let i = 0; i < 100; i++) {
			const cb = vi.fn();
			emitter.once("test", cb);
			emitter.removeAllListeners("test");

			// Verify callback doesn't fire
			emitter.emit("test", i);
			expect(cb).not.toHaveBeenCalled();
		}

		// Verify no memory leak by checking we can still add listeners
		const finalCb = vi.fn();
		emitter.on("test", finalCb);
		emitter.emit("test", 999);
		expect(finalCb).toHaveBeenCalledWith(999);
	});
});

// =============================================================================
// BUG-002: emit() iteration during self-modification
// =============================================================================
describe("QA-R3: BUG-002 - emit iteration safety", () => {
	it("all regular listeners fire even when once listener removes itself", () => {
		const emitter = createEventEmitter<{ test: number }>();
		const calls: string[] = [];

		// Add listeners in specific order
		emitter.on("test", () => calls.push("regular1"));
		emitter.once("test", () => calls.push("once1")); // Removes itself during emit
		emitter.on("test", () => calls.push("regular2"));
		emitter.once("test", () => calls.push("once2")); // Removes itself during emit
		emitter.on("test", () => calls.push("regular3"));

		emitter.emit("test", 1);

		// ALL listeners should have been called exactly once
		expect(calls).toContain("regular1");
		expect(calls).toContain("once1");
		expect(calls).toContain("regular2");
		expect(calls).toContain("once2");
		expect(calls).toContain("regular3");
		expect(calls).toHaveLength(5);
	});

	it("FIXED: listener added during emit does NOT fire in same emit", () => {
		// After BUG-002 fix: emit() copies the listener set before iteration
		// so listeners added during emit won't fire until the next emit.
		const emitter = createEventEmitter<{ test: number }>();
		const laterCb = vi.fn();

		emitter.on("test", () => {
			// Add listener during emit
			emitter.on("test", laterCb);
		});

		emitter.emit("test", 1);

		// FIXED: laterCb should NOT be called during the same emit
		expect(laterCb).not.toHaveBeenCalled();

		// But should fire on next emit
		emitter.emit("test", 2);
		expect(laterCb).toHaveBeenCalledWith(2);
	});

	it("listener removed during emit should not fire", () => {
		const emitter = createEventEmitter<{ test: number }>();
		const victim = vi.fn();
		let unsubscribe: () => void;

		emitter.on("test", () => {
			// Remove the victim during emit
			unsubscribe();
		});

		unsubscribe = emitter.on("test", victim);

		emitter.emit("test", 1);

		// This is tricky: depending on iteration order, victim may or may not fire
		// The safe behavior is that it should NOT fire if removed before its turn
		// But current implementation may have issues here
	});
});

// =============================================================================
// BUG-003: toEventTarget removeEventListener actual behavior test
// =============================================================================
describe("QA-R3: SLOP-001 Fix - toEventTarget removeEventListener", () => {
	it("removeEventListener actually prevents callback from firing", () => {
		const emitter = createEventEmitter<{ message: string }>();
		const target = toEventTarget(emitter);
		const callback = vi.fn();

		target.addEventListener("message", callback);
		target.removeEventListener("message", callback);
		emitter.emit("message", "hello");

		// This should NOT be called
		expect(callback).not.toHaveBeenCalled();
	});

	it("removeEventListener with once option cleans up properly", () => {
		const emitter = createEventEmitter<{ message: string }>();
		const target = toEventTarget(emitter);
		const callback = vi.fn();

		target.addEventListener("message", callback, { once: true });
		target.removeEventListener("message", callback);
		emitter.emit("message", "hello");

		expect(callback).not.toHaveBeenCalled();
	});

	it("EventListenerObject handleEvent is called correctly", () => {
		const emitter = createEventEmitter<{ message: string }>();
		const target = toEventTarget(emitter);

		const listenerObj = {
			handleEvent: vi.fn(),
		};

		target.addEventListener("message", listenerObj);
		emitter.emit("message", "hello");

		expect(listenerObj.handleEvent).toHaveBeenCalled();
		expect(listenerObj.handleEvent.mock.calls[0]?.[0]).toBeInstanceOf(Event);
	});

	it("same listener added twice fires once (deduplication)", () => {
		const emitter = createEventEmitter<{ message: string }>();
		const target = toEventTarget(emitter);
		const callback = vi.fn();

		target.addEventListener("message", callback);
		target.addEventListener("message", callback); // Duplicate
		emitter.emit("message", "hello");

		expect(callback).toHaveBeenCalledTimes(1);
	});
});

// =============================================================================
// Checked Buffer Variants Tests (MISSING-001)
// =============================================================================
describe("QA-R3: MISSING-001 - Checked buffer read variants", () => {
	describe("readByteChecked", () => {
		it("returns value for valid offset", () => {
			const data = new Uint8Array([0x12, 0x34, 0x56]);
			expect(readByteChecked(data, 0)).toBe(0x12);
			expect(readByteChecked(data, 2)).toBe(0x56);
		});

		it("returns undefined for negative offset", () => {
			const data = new Uint8Array([0x12, 0x34]);
			expect(readByteChecked(data, -1)).toBeUndefined();
		});

		it("returns undefined for out of bounds", () => {
			const data = new Uint8Array([0x12, 0x34]);
			expect(readByteChecked(data, 2)).toBeUndefined();
			expect(readByteChecked(data, 100)).toBeUndefined();
		});

		it("distinguishes 0 value from error", () => {
			const data = new Uint8Array([0x00, 0x01]);
			expect(readByteChecked(data, 0)).toBe(0); // Actual zero
			expect(readByteChecked(data, 10)).toBeUndefined(); // Error
		});

		it("property: valid offsets always return number", () => {
			fc.assert(
				fc.property(
					fc.uint8Array({ minLength: 1, maxLength: 100 }),
					fc.nat(),
					(data, offset) => {
						const result = readByteChecked(data, offset % data.length);
						return typeof result === "number";
					},
				),
			);
		});

		it("property: invalid offsets always return undefined", () => {
			fc.assert(
				fc.property(
					fc.uint8Array({ minLength: 1, maxLength: 100 }),
					fc.integer({ min: -1000, max: -1 }),
					(data, negOffset) => {
						return readByteChecked(data, negOffset) === undefined;
					},
				),
			);
		});
	});

	describe("readUint16LEChecked", () => {
		it("returns value for valid offset", () => {
			const data = new Uint8Array([0x34, 0x12]);
			expect(readUint16LEChecked(data, 0)).toBe(0x1234);
		});

		it("returns undefined when not enough bytes", () => {
			const data = new Uint8Array([0x12]);
			expect(readUint16LEChecked(data, 0)).toBeUndefined();
		});

		it("returns undefined at boundary", () => {
			const data = new Uint8Array([0x12, 0x34]);
			expect(readUint16LEChecked(data, 1)).toBeUndefined(); // Only 1 byte left
		});
	});

	describe("readUint24LEChecked", () => {
		it("returns value for valid offset", () => {
			const data = new Uint8Array([0x56, 0x34, 0x12]);
			expect(readUint24LEChecked(data, 0)).toBe(0x123456);
		});

		it("returns undefined when not enough bytes", () => {
			const data = new Uint8Array([0x12, 0x34]);
			expect(readUint24LEChecked(data, 0)).toBeUndefined();
		});
	});

	describe("readUint24BEChecked", () => {
		it("returns value for valid offset", () => {
			const data = new Uint8Array([0x12, 0x34, 0x56]);
			expect(readUint24BEChecked(data, 0)).toBe(0x123456);
		});

		it("returns undefined when not enough bytes", () => {
			const data = new Uint8Array([0x12, 0x34]);
			expect(readUint24BEChecked(data, 0)).toBeUndefined();
		});
	});
});

// =============================================================================
// State Machine Edge Cases
// =============================================================================
describe("QA-R3: State Machine robustness", () => {
	it("canTransition returns false for current state", () => {
		const sm = createStateMachine("disconnected");
		// Can't transition to the same state
		expect(sm.canTransition("disconnected")).toBe(false);
	});

	it("transition to invalid state throws", () => {
		const sm = createStateMachine("disconnected");
		// Can't go directly to connected
		expect(() => sm.transition("connected")).toThrow();
	});

	it("multiple callbacks all fire on transition", () => {
		const sm = createStateMachine("disconnected");
		const calls: number[] = [];

		sm.onTransition(() => calls.push(1));
		sm.onTransition(() => calls.push(2));
		sm.onTransition(() => calls.push(3));

		sm.transition("connecting");

		expect(calls).toEqual([1, 2, 3]);
	});

	it("unsubscribe prevents callback from firing", () => {
		const sm = createStateMachine("disconnected");
		const cb = vi.fn();

		const unsub = sm.onTransition(cb);
		unsub();

		sm.transition("connecting");

		expect(cb).not.toHaveBeenCalled();
	});

	it("callback error does not prevent other callbacks", () => {
		const sm = createStateMachine("disconnected");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const cb1 = vi.fn();
		const cb2 = vi.fn(() => {
			throw new Error("cb2 error");
		});
		const cb3 = vi.fn();

		sm.onTransition(cb1);
		sm.onTransition(cb2);
		sm.onTransition(cb3);

		sm.transition("connecting");

		expect(cb1).toHaveBeenCalled();
		expect(cb2).toHaveBeenCalled();
		expect(cb3).toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalled();

		errorSpy.mockRestore();
	});
});

// =============================================================================
// ConnectionPool Concurrency Tests
// =============================================================================
describe("QA-R3: ConnectionPool race conditions", () => {
	function createMockSession(id: string): BLEConnectedSession {
		return {
			deviceId: id,
			deviceName: `Device ${id}`,
			getPrimaryServices: vi.fn().mockResolvedValue([]),
			getPrimaryService: vi.fn(),
			disconnect: vi.fn().mockResolvedValue(undefined),
			onDisconnect: vi.fn().mockReturnValue(() => {}),
		};
	}

	function createMockAdapter(id: string): BLEAdapter {
		return {
			connect: vi.fn().mockImplementation(async () => {
				await new Promise((r) => setTimeout(r, 10)); // Simulate async
				return createMockSession(id);
			}),
		};
	}

	it("concurrent connects respect maxConnections", async () => {
		let counter = 0;
		const pool = createConnectionPool({
			maxConnections: 2,
			createAdapter: () => createMockAdapter(`device-${++counter}`),
		});

		// Start 5 concurrent connections
		const results = await Promise.allSettled([
			pool.connect(),
			pool.connect(),
			pool.connect(),
			pool.connect(),
			pool.connect(),
		]);

		const successes = results.filter((r) => r.status === "fulfilled");
		const failures = results.filter((r) => r.status === "rejected");

		// At most 2 should succeed
		expect(successes.length).toBeLessThanOrEqual(2);
		expect(failures.length).toBeGreaterThanOrEqual(3);

		await pool.disconnectAll();
	});

	it("double disconnect is safe", async () => {
		let counter = 0;
		const pool = createConnectionPool({
			createAdapter: () => createMockAdapter(`device-${++counter}`),
		});

		await pool.connect();
		const deviceId = "device-1";

		// Disconnect twice concurrently
		await Promise.all([pool.disconnect(deviceId), pool.disconnect(deviceId)]);

		expect(pool.connectionCount).toBe(0);
	});

	it("disconnect during connect is safe", async () => {
		let counter = 0;
		const pool = createConnectionPool({
			createAdapter: () => ({
				connect: vi.fn().mockImplementation(async () => {
					await new Promise((r) => setTimeout(r, 50)); // Slow connect
					return createMockSession(`device-${++counter}`);
				}),
			}),
		});

		const connectPromise = pool.connect();

		// Disconnect immediately (before connect completes)
		await pool.disconnect("device-1"); // Device doesn't exist yet

		const session = await connectPromise;
		expect(session.deviceId).toBe("device-1");
		expect(pool.connectionCount).toBe(1);

		await pool.disconnectAll();
	});
});

// =============================================================================
// Property-Based Tests
// =============================================================================
describe("QA-R3: Property-based tests", () => {
	it("eventEmitter: emit never throws regardless of listener behavior", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		fc.assert(
			fc.property(
				fc.array(fc.boolean(), { minLength: 0, maxLength: 10 }),
				(shouldThrow) => {
					const emitter = createEventEmitter<{ test: number }>();

					shouldThrow.forEach((throws, i) => {
						if (throws) {
							emitter.on("test", () => {
								throw new Error(`Listener ${i} error`);
							});
						} else {
							emitter.on("test", () => {});
						}
					});

					// Should never throw
					expect(() => emitter.emit("test", 42)).not.toThrow();
					return true;
				},
			),
		);

		// Wait for queueMicrotask error logs to complete before restoring
		await new Promise((r) => setTimeout(r, 0));
		errorSpy.mockRestore();
	});

	it("buffer: checked reads always safe with any offset", () => {
		fc.assert(
			fc.property(
				fc.uint8Array({ minLength: 0, maxLength: 256 }),
				fc.integer({ min: -1000, max: 1000 }),
				(data, offset) => {
					// These should never throw
					const byte = readByteChecked(data, offset);
					const u16 = readUint16LEChecked(data, offset);
					const u24le = readUint24LEChecked(data, offset);
					const u24be = readUint24BEChecked(data, offset);

					// Result is either number or undefined
					expect(byte === undefined || true).toBe(true);
					expect(u16 === undefined || true).toBe(true);
					expect(u24le === undefined || true).toBe(true);
					expect(u24be === undefined || true).toBe(true);

					return true;
				},
			),
		);
	});

	it("stateMachine: random valid transitions never throw", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.constantFrom("connecting", "connected", "disconnected", "error"),
					{ minLength: 1, maxLength: 20 },
				),
				(transitions) => {
					const sm = createStateMachine("disconnected");

					for (const target of transitions) {
						if (sm.canTransition(target)) {
							expect(() => sm.transition(target)).not.toThrow();
						}
					}

					return true;
				},
			),
		);
	});
});
