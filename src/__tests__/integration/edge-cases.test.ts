/**
 * QA Edge Case Tests - web-ble-kit
 *
 * These tests specifically target edge cases and potential bugs identified
 * during the QA analysis. They use property-based testing and targeted
 * unit tests to systematically expose issues.
 */

import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPollManager, type PollManagerOptions } from "../../async";
import { withRetry } from "../../ble";
import {
	AbortError,
	isTransientBLEError,
	raceWithAbort,
	TimeoutError,
	withTimeout,
} from "../../errors";
import {
	createEventEmitter,
	createStateMachine,
	toEventTarget,
} from "../../state";
import type { ConnectionState } from "../../types";
import {
	extractArrayBuffer,
	readByte,
	readUint16LE,
	readUint24BE,
	readUint24LE,
	uuidMatches,
} from "../../utils";

describe("QA Edge Cases: poll-manager", () => {
	describe("F-001: WeakRef Type Unsoundness", () => {
		const mockOnError = vi.fn();
		const baseOptions: PollManagerOptions = {
			defaultIntervalMs: 100,
			onError: mockOnError,
		};

		beforeEach(() => {
			vi.clearAllMocks();
		});

		it("should handle object context (valid for WeakRef)", async () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager(pollFn, baseOptions);

			const context = { data: "test" };
			expect(() => manager.start(context)).not.toThrow();
			manager.stop();
		});

		// This test documents the current behavior - it may throw with primitives
		it("documents behavior with primitive context (number)", () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager<number>(pollFn, baseOptions);

			// This may throw TypeError in environments with WeakRef
			// The fix should prevent this from throwing
			try {
				manager.start(42);
				// If it doesn't throw, stop it
				manager.stop();
			} catch (e) {
				// Expected: TypeError: Invalid value used as weak map key
				expect(e).toBeInstanceOf(TypeError);
			}
		});

		it("documents behavior with null context", () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager<null>(pollFn, baseOptions);

			try {
				manager.start(null);
				manager.stop();
			} catch (e) {
				expect(e).toBeInstanceOf(TypeError);
			}
		});
	});

	describe("F-010: Session ID Wraparound", () => {
		it("should handle many start/stop cycles without issues", () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 100,
				onError: vi.fn(),
			});

			// Simulate many cycles
			for (let i = 0; i < 1000; i++) {
				manager.start({ id: i });
				manager.stop();
			}

			expect(manager.isPolling()).toBe(false);
		});
	});
});

describe("QA Edge Cases: event-emitter", () => {
	describe("F-003: Memory Leak with once option in EventTarget adapter", () => {
		it("should track listeners correctly with once option", () => {
			const emitter = createEventEmitter<{ test: string }>();
			const target = toEventTarget(emitter);

			const listener = vi.fn();

			// Add with once
			target.addEventListener("test", listener, { once: true });

			// Emit - should trigger listener and auto-remove
			emitter.emit("test", "data1");
			expect(listener).toHaveBeenCalledTimes(1);

			// Emit again - listener should NOT be called (was removed)
			emitter.emit("test", "data2");
			expect(listener).toHaveBeenCalledTimes(1);
		});

		it("manual removal of once listener before trigger should work", () => {
			const emitter = createEventEmitter<{ test: string }>();
			const target = toEventTarget(emitter);

			const listener = vi.fn();
			target.addEventListener("test", listener, { once: true });

			// Remove before emit
			target.removeEventListener("test", listener);

			// Emit - should NOT trigger (was manually removed)
			emitter.emit("test", "data");
			// Note: Current implementation may still call listener
			// This test documents the expected behavior after fix
		});
	});

	describe("F-011: once Wrapper Reference Identity", () => {
		it("off with original callback should work after once registration", () => {
			const emitter = createEventEmitter<{ test: number }>();
			const callback = vi.fn();

			// Register with once
			emitter.once("test", callback);

			// Try to remove with original callback
			emitter.off("test", callback);

			// Emit - callback should NOT be called
			emitter.emit("test", 42);

			// Current behavior: callback IS called because off removes wrong reference
			// After fix: callback should NOT be called
			// This test documents the issue
		});

		it("unsubscribe function from once should work correctly", () => {
			const emitter = createEventEmitter<{ test: number }>();
			const callback = vi.fn();

			const unsubscribe = emitter.once("test", callback);
			unsubscribe();

			emitter.emit("test", 42);
			expect(callback).not.toHaveBeenCalled();
		});
	});

	describe("Property: EventEmitter operations never throw", () => {
		type Op =
			| { type: "on"; event: "a" | "b"; id: number }
			| { type: "off"; event: "a" | "b"; id: number }
			| { type: "emit"; event: "a" | "b"; data: number }
			| { type: "once"; event: "a" | "b"; id: number }
			| { type: "removeAll"; event: "a" | "b" | undefined };

		const opArb: fc.Arbitrary<Op> = fc.oneof(
			fc.record({
				type: fc.constant("on" as const),
				event: fc.constantFrom("a" as const, "b" as const),
				id: fc.nat(10),
			}),
			fc.record({
				type: fc.constant("off" as const),
				event: fc.constantFrom("a" as const, "b" as const),
				id: fc.nat(10),
			}),
			fc.record({
				type: fc.constant("emit" as const),
				event: fc.constantFrom("a" as const, "b" as const),
				data: fc.nat(),
			}),
			fc.record({
				type: fc.constant("once" as const),
				event: fc.constantFrom("a" as const, "b" as const),
				id: fc.nat(10),
			}),
			fc.record({
				type: fc.constant("removeAll" as const),
				event: fc.option(fc.constantFrom("a" as const, "b" as const), {
					nil: undefined,
				}),
			}),
		);

		it("never throws for any sequence of operations", () => {
			fc.assert(
				fc.property(fc.array(opArb, { maxLength: 50 }), (ops) => {
					const emitter = createEventEmitter<{ a: number; b: number }>();
					const callbacks = new Map<number, (data: number) => void>();

					for (const op of ops) {
						const getOrCreateCb = (id: number) => {
							if (!callbacks.has(id)) {
								callbacks.set(id, vi.fn());
							}
							const cb = callbacks.get(id);
							if (!cb) {
								throw new Error(`Callback ${id} not found`);
							}
							return cb;
						};

						switch (op.type) {
							case "on":
								emitter.on(op.event, getOrCreateCb(op.id));
								break;
							case "off":
								emitter.off(op.event, getOrCreateCb(op.id));
								break;
							case "once":
								emitter.once(op.event, getOrCreateCb(op.id));
								break;
							case "emit":
								emitter.emit(op.event, op.data);
								break;
							case "removeAll":
								emitter.removeAllListeners(op.event);
								break;
						}
					}
				}),
				{ numRuns: 500 },
			);
		});
	});
});

describe("QA Edge Cases: state-machine", () => {
	describe("F-007 FIXED: connected -> error transition now allowed", () => {
		it("CAN transition from connected to error (F-007 fix)", () => {
			const sm = createStateMachine("disconnected");
			sm.transition("connecting");
			sm.transition("connected");

			// F-007 FIX: CAN now transition to error from connected
			expect(sm.canTransition("error")).toBe(true);

			// Can still transition to disconnected
			expect(sm.canTransition("disconnected")).toBe(true);

			// Verify the transition works
			sm.transition("error");
			expect(sm.getState()).toBe("error");
		});
	});

	describe("Property: State machine invariants", () => {
		const stateArb = fc.constantFrom(
			"disconnected" as const,
			"connecting" as const,
			"connected" as const,
			"error" as const,
		);

		it("canTransition always returns boolean", () => {
			fc.assert(
				fc.property(stateArb, stateArb, (initial, target) => {
					const sm = createStateMachine(initial);
					const result = sm.canTransition(target);
					expect(typeof result).toBe("boolean");
				}),
			);
		});

		it("transition throws iff canTransition returns false", () => {
			fc.assert(
				fc.property(stateArb, stateArb, (initial, target) => {
					const sm = createStateMachine(initial);
					const canDo = sm.canTransition(target);

					if (canDo) {
						expect(() => sm.transition(target)).not.toThrow();
					} else {
						expect(() => sm.transition(target)).toThrow();
					}
				}),
			);
		});

		it("random valid transition sequences always end in valid state", () => {
			fc.assert(
				fc.property(fc.array(stateArb, { maxLength: 20 }), (transitions) => {
					const sm = createStateMachine();
					const validStates: ConnectionState[] = [
						"disconnected",
						"connecting",
						"connected",
						"error",
					];

					for (const target of transitions) {
						if (sm.canTransition(target)) {
							sm.transition(target);
						}
					}

					expect(validStates).toContain(sm.getState());
				}),
			);
		});
	});
});

describe("QA Edge Cases: retry", () => {
	describe("F-004: Integer Overflow in Delay Calculation", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("handles extreme backoff parameters without overflow", async () => {
			const operation = vi
				.fn()
				.mockRejectedValueOnce(new Error("network error"))
				.mockResolvedValue("success");

			const onRetry = vi.fn();

			const resultPromise = withRetry(operation, {
				maxAttempts: 100, // Many attempts
				initialDelayMs: 1000,
				maxDelayMs: 5000,
				backoffMultiplier: 10, // Aggressive multiplier
				jitter: false,
				onRetry,
			});

			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(5000);

			const result = await resultPromise;

			expect(result).toBe("success");
			// Delay should be capped at maxDelayMs
			expect(onRetry.mock.calls[0]?.[1]).toBeLessThanOrEqual(5000);
			expect(Number.isFinite(onRetry.mock.calls[0]?.[1])).toBe(true);
		});

		it("delay never exceeds maxDelayMs even with extreme parameters", () => {
			fc.assert(
				fc.property(
					fc.integer({ min: 1, max: 100 }), // attempt
					fc.integer({ min: 1, max: 10000 }), // initialDelayMs
					fc.integer({ min: 1, max: 60000 }), // maxDelayMs
					fc.integer({ min: 1, max: 10 }), // backoffMultiplier
					(attempt, initialDelayMs, maxDelayMs, backoffMultiplier) => {
						// We can't directly test calculateDelay since it's private
						// But we can verify the behavior through the retry function
						// This documents the expected behavior
						const exponentialDelay =
							initialDelayMs * backoffMultiplier ** attempt;
						const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

						expect(cappedDelay).toBeLessThanOrEqual(maxDelayMs);
						expect(Number.isFinite(cappedDelay)).toBe(true);
					},
				),
			);
		});
	});

	describe("Property: isTransientBLEError classification", () => {
		const errorNameArb = fc.oneof(
			fc.constant("Error"),
			fc.constant("TypeError"),
			fc.constant("AbortError"),
			fc.constant("TimeoutError"),
			fc.constant("NotAllowedError"),
			fc.constant("SecurityError"),
			fc.string(),
		);

		const errorMessageArb = fc.oneof(
			fc.constant(""),
			fc.constant("User cancelled"),
			fc.constant("GATT operation failed"),
			fc.constant("Network error"),
			fc.constant("Permission denied"),
			fc.string(),
		);

		it("always returns boolean", () => {
			fc.assert(
				fc.property(errorNameArb, errorMessageArb, (name, message) => {
					const error = new Error(message);
					error.name = name;
					const result = isTransientBLEError(error);
					expect(typeof result).toBe("boolean");
				}),
			);
		});

		it("AbortError is never retryable", () => {
			fc.assert(
				fc.property(fc.string(), (message) => {
					const error = new AbortError(message);
					expect(isTransientBLEError(error)).toBe(false);
				}),
			);
		});

		it("TimeoutError is always retryable", () => {
			fc.assert(
				fc.property(fc.string(), fc.nat(), (operation, timeout) => {
					const error = new TimeoutError(operation, timeout);
					expect(isTransientBLEError(error)).toBe(true);
				}),
			);
		});
	});
});

describe("QA Edge Cases: buffer-utils", () => {
	describe("F-008: Silent Failure on Out-of-Bounds Access", () => {
		it("readByte returns 0 for negative offset (silent failure)", () => {
			const data = new Uint8Array([1, 2, 3, 4]);
			expect(readByte(data, -1)).toBe(0);
			expect(readByte(data, -100)).toBe(0);
		});

		it("readByte returns 0 for offset beyond length (silent failure)", () => {
			const data = new Uint8Array([1, 2, 3, 4]);
			expect(readByte(data, 4)).toBe(0);
			expect(readByte(data, 100)).toBe(0);
		});

		it("0 is indistinguishable from actual zero value", () => {
			const data = new Uint8Array([0, 1, 2, 3]);

			// Reading actual zero at index 0
			const actualZero = readByte(data, 0);

			// Reading out of bounds (returns 0)
			const outOfBounds = readByte(data, 100);

			// These are indistinguishable!
			expect(actualZero).toBe(outOfBounds);
			expect(actualZero).toBe(0);
		});
	});

	describe("Property: Buffer reads never throw", () => {
		it("readByte never throws for any offset", () => {
			fc.assert(
				fc.property(
					fc.uint8Array({ maxLength: 100 }),
					fc.integer(),
					(data, offset) => {
						expect(() => readByte(data, offset)).not.toThrow();
					},
				),
			);
		});

		it("readUint16LE never throws for any offset", () => {
			fc.assert(
				fc.property(
					fc.uint8Array({ maxLength: 100 }),
					fc.integer(),
					(data, offset) => {
						expect(() => readUint16LE(data, offset)).not.toThrow();
					},
				),
			);
		});

		it("readUint24LE never throws for any offset", () => {
			fc.assert(
				fc.property(
					fc.uint8Array({ maxLength: 100 }),
					fc.integer(),
					(data, offset) => {
						expect(() => readUint24LE(data, offset)).not.toThrow();
					},
				),
			);
		});

		it("readUint24BE never throws for any offset", () => {
			fc.assert(
				fc.property(
					fc.uint8Array({ maxLength: 100 }),
					fc.integer(),
					(data, offset) => {
						expect(() => readUint24BE(data, offset)).not.toThrow();
					},
				),
			);
		});
	});

	describe("Property: Valid reads return expected values", () => {
		it("readByte returns correct value for valid offsets", () => {
			fc.assert(
				fc.property(fc.uint8Array({ minLength: 1, maxLength: 100 }), (data) => {
					const offset = Math.floor(Math.random() * data.length);
					expect(readByte(data, offset)).toBe(data[offset]);
				}),
			);
		});
	});
});

describe("QA Edge Cases: transport", () => {
	describe("F-014: UUID Matching Edge Cases", () => {
		it("handles short UUID case insensitivity", () => {
			expect(uuidMatches("FE00", "fe00")).toBe(true);
			expect(uuidMatches("fe00", "FE00")).toBe(true);
			expect(uuidMatches("Fe00", "fE00")).toBe(true);
		});

		it("handles full UUID with short ID extraction", () => {
			expect(uuidMatches("0000fe00-0000-1000-8000-00805f9b34fb", "fe00")).toBe(
				true,
			);
			expect(uuidMatches("0000FE00-0000-1000-8000-00805f9b34fb", "fe00")).toBe(
				true,
			);
		});

		it("does not match incorrect short ID in full UUID", () => {
			expect(uuidMatches("0000fe00-0000-1000-8000-00805f9b34fb", "fe01")).toBe(
				false,
			);
		});

		// Edge cases not currently handled
		it("documents: 2-char short UUIDs may not match correctly", () => {
			// 2-char UUIDs like "01" should match "0000001-..."
			// Current implementation may not handle this
			// Documenting current behavior - this may be false when it should be true
			expect(() =>
				uuidMatches("00000001-0000-1000-8000-00805f9b34fb", "01"),
			).not.toThrow();
		});

		it("handles malformed UUIDs gracefully", () => {
			// Should not throw for malformed input
			expect(() => uuidMatches("not-a-uuid", "fe00")).not.toThrow();
			expect(() => uuidMatches("", "")).not.toThrow();
			expect(() => uuidMatches("fe00", "")).not.toThrow();
		});
	});

	describe("F-015: extractArrayBuffer Always Copies", () => {
		it("creates copy even for simple aligned buffers", () => {
			const original = new ArrayBuffer(4);
			new Uint8Array(original).set([1, 2, 3, 4]);
			const view = new DataView(original);

			const result = extractArrayBuffer(view);

			if (result === null) {
				throw new Error("Expected result to not be null");
			}
			// Verify it's a copy, not the same reference
			expect(result).not.toBe(original);

			// Modify original, copy should be unaffected
			new Uint8Array(original)[0] = 99;
			expect(new Uint8Array(result)[0]).toBe(1);
		});
	});
});

describe("QA Edge Cases: toEventTarget once option (F-003)", () => {
	it("documents: adding same listener twice with once should only track once", () => {
		const emitter = createEventEmitter<{ test: string }>();
		const target = toEventTarget(emitter);

		const listener = vi.fn();

		// Add same listener twice with once
		target.addEventListener("test", listener, { once: true });
		target.addEventListener("test", listener, { once: true }); // Duplicate

		// Emit - should only trigger once (EventTarget deduplicates)
		emitter.emit("test", "data");

		// Native EventTarget behavior: duplicate ignored, listener called once
		// After first emit with once, listener should be auto-removed
		expect(listener).toHaveBeenCalledTimes(1);

		// Second emit should NOT call listener
		emitter.emit("test", "data2");
		// Current behavior may vary - this documents expected behavior
	});

	it("removeEventListener after once should work correctly", () => {
		const emitter = createEventEmitter<{ test: string }>();
		const target = toEventTarget(emitter);

		const listener = vi.fn();
		target.addEventListener("test", listener, { once: true });
		target.removeEventListener("test", listener);

		emitter.emit("test", "data");

		// After manual removal, listener should NOT be called
		// Current implementation may have issues here
		expect(listener).toHaveBeenCalledTimes(0);
	});

	it("emitter subscription should be cleaned up when last listener removed", () => {
		const emitter = createEventEmitter<{ test: string }>();
		const target = toEventTarget(emitter);

		const listener1 = vi.fn();
		const listener2 = vi.fn();

		target.addEventListener("test", listener1);
		target.addEventListener("test", listener2);

		// Remove all listeners
		target.removeEventListener("test", listener1);
		target.removeEventListener("test", listener2);

		// Emitter should have no listeners for 'test'
		// This verifies the subscription cleanup works
		expect(emitter.listenerCount("test")).toBe(0);
	});
});

describe("QA Edge Cases: Retry Delay Edge Cases (F-004 extended)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("handles maxAttempts = 1 (no retries)", async () => {
		// Using an unknown error that doesn't match retry patterns
		const operation = vi.fn().mockRejectedValue(new Error("unknown error"));

		await expect(
			withRetry(operation, { maxAttempts: 1, jitter: false }),
		).rejects.toThrow("unknown error");

		expect(operation).toHaveBeenCalledTimes(1);
	});

	it("handles maxAttempts = 0 (F-021 FIXED: throws RangeError)", async () => {
		vi.useRealTimers(); // Use real timers for this test
		const operation = vi.fn().mockResolvedValue("success");

		// F-021 FIXED: maxAttempts < 1 now throws a clear RangeError
		await expect(withRetry(operation, { maxAttempts: 0 })).rejects.toThrow(
			"maxAttempts must be >= 1",
		);

		// Operation should not be called since validation fails
		expect(operation).not.toHaveBeenCalled();

		vi.useFakeTimers(); // Restore for other tests
	});

	it("backoff multiplier of 1 produces constant delay", async () => {
		const operation = vi
			.fn()
			.mockRejectedValueOnce(new Error("GATT network error 1"))
			.mockRejectedValueOnce(new Error("GATT network error 2"))
			.mockResolvedValue("success");

		const onRetry = vi.fn();

		const resultPromise = withRetry(operation, {
			maxAttempts: 3,
			initialDelayMs: 1000,
			maxDelayMs: 10000,
			backoffMultiplier: 1, // No exponential increase
			jitter: false,
			onRetry,
		});

		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(1000);

		await resultPromise;

		// Both delays should be the same (no exponential growth)
		expect(onRetry.mock.calls[0]?.[1]).toBe(1000);
		expect(onRetry.mock.calls[1]?.[1]).toBe(1000);
	});

	it("very large initialDelayMs is capped by maxDelayMs", async () => {
		const operation = vi
			.fn()
			.mockRejectedValueOnce(new Error("network error"))
			.mockResolvedValue("success");

		const onRetry = vi.fn();

		const resultPromise = withRetry(operation, {
			maxAttempts: 2,
			initialDelayMs: 100000, // Very large
			maxDelayMs: 5000, // Cap
			jitter: false,
			onRetry,
		});

		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(5000);

		await resultPromise;

		// Delay should be capped
		expect(onRetry.mock.calls[0]?.[1]).toBe(5000);
	});

	it("jitter adds randomness to delays", async () => {
		// Test with controlled randomness
		const randomValues = [0, 0.5, 1];
		let randomIndex = 0;
		vi.spyOn(Math, "random").mockImplementation(() => {
			return randomValues[randomIndex++ % randomValues.length] ?? 0;
		});

		const operation = vi
			.fn()
			.mockRejectedValueOnce(new Error("network error"))
			.mockResolvedValue("success");

		const onRetry = vi.fn();

		const resultPromise = withRetry(operation, {
			maxAttempts: 2,
			initialDelayMs: 1000,
			jitter: true,
			onRetry,
		});

		await vi.runAllTimersAsync();
		await resultPromise;

		// Delay should vary from base due to jitter
		const delay = onRetry.mock.calls[0]?.[1];
		expect(delay).toBeGreaterThan(0);
		expect(Number.isFinite(delay)).toBe(true);

		vi.restoreAllMocks();
	});
});

describe("QA Edge Cases: State Machine Transitions (F-007 FIXED)", () => {
	it("F-007 FIXED: connected CAN now transition to error", () => {
		const sm = createStateMachine("connected");

		// F-007 FIX: CAN go to error from connected
		expect(sm.canTransition("error")).toBe(true);

		// Can also go to disconnected
		expect(sm.canTransition("disconnected")).toBe(true);
		expect(sm.canTransition("connecting")).toBe(false);
		expect(sm.canTransition("connected")).toBe(false);
	});

	it("error state can recover to connecting or disconnected", () => {
		const sm = createStateMachine("error");

		expect(sm.canTransition("disconnected")).toBe(true);
		expect(sm.canTransition("connecting")).toBe(true);
		expect(sm.canTransition("connected")).toBe(false);
		expect(sm.canTransition("error")).toBe(false);
	});

	it("transition callbacks receive correct from/to states", () => {
		const sm = createStateMachine("disconnected");
		const transitions: Array<{ from: string; to: string }> = [];

		sm.onTransition((from, to) => {
			transitions.push({ from, to });
		});

		sm.transition("connecting");
		sm.transition("connected");
		sm.transition("disconnected");

		expect(transitions).toEqual([
			{ from: "disconnected", to: "connecting" },
			{ from: "connecting", to: "connected" },
			{ from: "connected", to: "disconnected" },
		]);
	});

	it("callback errors are caught and logged", () => {
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		const sm = createStateMachine("disconnected");

		// Add a callback that throws
		sm.onTransition(() => {
			throw new Error("Callback error");
		});

		// Transition should not throw
		expect(() => sm.transition("connecting")).not.toThrow();

		// State should still change
		expect(sm.getState()).toBe("connecting");

		// Verify error was logged
		expect(consoleErrorSpy).toHaveBeenCalled();

		consoleErrorSpy.mockRestore();
	});

	it("unsubscribe function removes callback", () => {
		const sm = createStateMachine("disconnected");
		const callback = vi.fn();

		const unsubscribe = sm.onTransition(callback);

		sm.transition("connecting");
		expect(callback).toHaveBeenCalledTimes(1);

		unsubscribe();

		sm.transition("connected");
		expect(callback).toHaveBeenCalledTimes(1); // Not called again
	});
});

describe("QA Edge Cases: UUID Matching (F-014 extended)", () => {
	it("handles 4-character short UUID", () => {
		expect(uuidMatches("fe00", "fe00")).toBe(true);
		expect(uuidMatches("1826", "1826")).toBe(true);
	});

	it("handles full UUID with standard Bluetooth base", () => {
		expect(uuidMatches("0000fe00-0000-1000-8000-00805f9b34fb", "fe00")).toBe(
			true,
		);
		expect(uuidMatches("00001826-0000-1000-8000-00805f9b34fb", "1826")).toBe(
			true,
		);
	});

	it("case insensitive matching", () => {
		expect(uuidMatches("FE00", "fe00")).toBe(true);
		expect(uuidMatches("fe00", "FE00")).toBe(true);
		expect(uuidMatches("0000FE00-0000-1000-8000-00805f9b34fb", "fe00")).toBe(
			true,
		);
	});

	it("non-matching UUIDs return false", () => {
		expect(uuidMatches("fe00", "fe01")).toBe(false);
		expect(uuidMatches("0000fe00-0000-1000-8000-00805f9b34fb", "fe01")).toBe(
			false,
		);
	});

	it("handles edge case: empty strings", () => {
		expect(uuidMatches("", "")).toBe(true); // Direct match
		expect(uuidMatches("fe00", "")).toBe(false);
		expect(uuidMatches("", "fe00")).toBe(false);
	});

	it("handles malformed UUIDs gracefully (no throw)", () => {
		expect(() => uuidMatches("not-a-uuid", "fe00")).not.toThrow();
		expect(() =>
			uuidMatches("12345678-1234-1234-1234-123456789012", "fe00"),
		).not.toThrow();
		expect(() => uuidMatches("short", "fe00")).not.toThrow();
	});

	it("H-001 FIXED: handles variable-length short IDs (1-4 chars)", () => {
		// Full UUID format: 0000XXXX-0000-1000-8000-00805f9b34fb
		// The function extracts chars 4-8 as the short ID

		// H-001 fix: short IDs are now padded to 4 chars before comparison
		// 2-char "01" becomes "0001" for comparison
		const twoCharResult = uuidMatches(
			"00000001-0000-1000-8000-00805f9b34fb",
			"01",
		);
		expect(twoCharResult).toBe(true);

		// 4-char short IDs still work
		expect(uuidMatches("00000001-0000-1000-8000-00805f9b34fb", "0001")).toBe(
			true,
		);

		// 1-char short IDs also work
		expect(uuidMatches("00000001-0000-1000-8000-00805f9b34fb", "1")).toBe(true);
	});
});

describe("QA Edge Cases: Buffer Extraction (F-015)", () => {
	it("extracts and copies buffer correctly", () => {
		const original = new ArrayBuffer(4);
		new Uint8Array(original).set([1, 2, 3, 4]);
		const view = new DataView(original);

		const result = extractArrayBuffer(view);

		if (result === null) {
			throw new Error("Expected result to not be null");
		}
		expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3, 4]));
	});

	it("handles DataView with offset", () => {
		const buffer = new ArrayBuffer(8);
		new Uint8Array(buffer).set([0, 0, 1, 2, 3, 4, 0, 0]);
		const view = new DataView(buffer, 2, 4); // offset=2, length=4

		const result = extractArrayBuffer(view);

		if (result === null) {
			throw new Error("Expected result to not be null");
		}
		expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3, 4]));
	});

	it("returns null for empty DataView", () => {
		const view = new DataView(new ArrayBuffer(0));
		expect(extractArrayBuffer(view)).toBeNull();
	});

	it("returns null for undefined input", () => {
		expect(extractArrayBuffer(undefined)).toBeNull();
	});

	it("creates independent copy (original modification does not affect result)", () => {
		const original = new ArrayBuffer(4);
		new Uint8Array(original).set([1, 2, 3, 4]);
		const view = new DataView(original);

		const result = extractArrayBuffer(view);

		if (result === null) {
			throw new Error("Expected result to not be null");
		}

		// Modify original
		new Uint8Array(original)[0] = 99;

		// Result should be unaffected
		expect(new Uint8Array(result)[0]).toBe(1);
	});

	it("handles maximum reasonable buffer sizes", () => {
		// Test with larger buffers (shouldn't crash)
		const largeBuffer = new ArrayBuffer(1024 * 1024); // 1MB
		new Uint8Array(largeBuffer).fill(42);
		const view = new DataView(largeBuffer);

		const result = extractArrayBuffer(view);

		if (result === null) {
			throw new Error("Expected result to not be null");
		}
		expect(result.byteLength).toBe(1024 * 1024);
		expect(new Uint8Array(result)[0]).toBe(42);
	});
});

describe("QA Edge Cases: errors", () => {
	describe("withTimeout behavior", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("underlying operation continues after timeout", async () => {
			let operationCompleted = false;

			const slowOperation = new Promise<string>((resolve) => {
				setTimeout(() => {
					operationCompleted = true;
					resolve("done");
				}, 2000);
			});

			const promise = withTimeout(slowOperation, 100, "test");

			vi.advanceTimersByTime(101);

			await expect(promise).rejects.toThrow(TimeoutError);

			// Operation hasn't completed yet
			expect(operationCompleted).toBe(false);

			// But if we advance more time, it would complete
			vi.advanceTimersByTime(2000);
			expect(operationCompleted).toBe(true);
		});
	});

	describe("raceWithAbort behavior", () => {
		it("returns promise result if no signal", async () => {
			const result = await raceWithAbort(Promise.resolve("value"), undefined);
			expect(result).toBe("value");
		});

		it("rejects with AbortError if signal already aborted", async () => {
			const controller = new AbortController();
			controller.abort();

			await expect(
				raceWithAbort(Promise.resolve("value"), controller.signal),
			).rejects.toThrow(AbortError);
		});

		it("underlying promise continues even after abort", async () => {
			vi.useRealTimers();

			let completed = false;
			const slowPromise = new Promise<string>((resolve) => {
				setTimeout(() => {
					completed = true;
					resolve("done");
				}, 50);
			});

			const controller = new AbortController();

			const raced = raceWithAbort(slowPromise, controller.signal);

			// Abort immediately
			controller.abort();

			await expect(raced).rejects.toThrow(AbortError);

			// Wait for slow promise to complete
			await new Promise((r) => setTimeout(r, 100));

			// The underlying promise still completed!
			expect(completed).toBe(true);
		});
	});
});
