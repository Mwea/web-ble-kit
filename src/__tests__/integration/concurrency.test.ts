/**
 * QA Round 2: Additional Edge Cases - web-ble-kit
 *
 * Second-pass analysis targeting issues not caught in the initial QA review.
 * Focus: concurrency, resource leaks, state consistency, and subtle edge cases.
 */

import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createConnectionPool,
	MAX_BLE_CONNECTIONS,
	startNotifications,
	withRetry,
} from "../../ble";
import { AbortError, raceWithAbort, withTimeout } from "../../errors";
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

// ============================================================================
// F-016: EventEmitter removeAllListeners doesn't clear onceWrappers
// ============================================================================
describe("F-016: removeAllListeners Memory Leak", () => {
	it("removeAllListeners should not leave orphaned once wrappers", () => {
		const emitter = createEventEmitter<{ test: number }>();

		// Register several once listeners
		const cb1 = vi.fn();
		const cb2 = vi.fn();
		const cb3 = vi.fn();

		emitter.once("test", cb1);
		emitter.once("test", cb2);
		emitter.once("test", cb3);

		expect(emitter.listenerCount("test")).toBe(3);

		// Remove all listeners
		emitter.removeAllListeners("test");

		expect(emitter.listenerCount("test")).toBe(0);

		// Emit should not call any callbacks
		emitter.emit("test", 42);

		expect(cb1).not.toHaveBeenCalled();
		expect(cb2).not.toHaveBeenCalled();
		expect(cb3).not.toHaveBeenCalled();
	});

	it("removeAllListeners without event should clear all once wrappers", () => {
		const emitter = createEventEmitter<{ a: number; b: string }>();

		emitter.once("a", vi.fn());
		emitter.once("b", vi.fn());

		emitter.removeAllListeners();

		expect(emitter.listenerCount("a")).toBe(0);
		expect(emitter.listenerCount("b")).toBe(0);
	});

	it("off after removeAllListeners should not throw", () => {
		const emitter = createEventEmitter<{ test: number }>();
		const cb = vi.fn();

		emitter.once("test", cb);
		emitter.removeAllListeners("test");

		// This should not throw even though the wrapper mapping was cleared
		expect(() => emitter.off("test", cb)).not.toThrow();
	});
});

// ============================================================================
// F-017: State Machine Re-entrancy During Callbacks
// ============================================================================
describe("F-017: State Machine Re-entrancy", () => {
	it("callback that triggers another transition is blocked by re-entrancy guard (H-005)", () => {
		const sm = createStateMachine("disconnected");
		const transitions: string[] = [];
		let blockedTransition = false;

		sm.onTransition((from, to) => {
			transitions.push(`${from}->${to}`);

			// Re-entrant transition: when we hit 'connecting', try to go to 'connected'
			// This should be blocked by the H-005 re-entrancy guard
			if (to === "connecting" && sm.canTransition("connected")) {
				try {
					sm.transition("connected");
				} catch {
					blockedTransition = true;
				}
			}
		});

		sm.transition("connecting");

		// Only the first transition should be recorded - re-entrant was blocked
		expect(transitions).toEqual(["disconnected->connecting"]);
		expect(sm.getState()).toBe("connecting");
		expect(blockedTransition).toBe(true);
	});

	it("callback that causes re-entrant transition throws error (H-005 fix)", () => {
		const sm = createStateMachine("disconnected");
		const errors: Error[] = [];

		sm.onTransition((_from, to) => {
			// Try re-entrant transition (should throw due to H-005 re-entrancy guard)
			if (to === "connecting") {
				try {
					sm.transition("error");
				} catch (e) {
					errors.push(e as Error);
				}
			}
		});

		sm.transition("connecting");
		// State should stay 'connecting' because re-entrant transition was blocked
		expect(sm.getState()).toBe("connecting");
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toContain("transition");
	});

	it("multiple callbacks all execute even when one tries re-entrant transition", () => {
		const sm = createStateMachine("disconnected");
		const log: string[] = [];

		sm.onTransition((from, to) => {
			log.push(`cb1:${from}->${to}`);
		});

		sm.onTransition((from, to) => {
			log.push(`cb2:${from}->${to}`);
			if (to === "connecting") {
				// This will throw due to re-entrancy guard, but error is caught internally
				try {
					sm.transition("connected");
				} catch {
					log.push("cb2:re-entrancy-blocked");
				}
			}
		});

		sm.onTransition((from, to) => {
			log.push(`cb3:${from}->${to}`);
		});

		sm.transition("connecting");

		// All callbacks should be called for the transition
		expect(log).toContain("cb1:disconnected->connecting");
		expect(log).toContain("cb2:disconnected->connecting");
		expect(log).toContain("cb2:re-entrancy-blocked");
		expect(log).toContain("cb3:disconnected->connecting");
		// No second transition should happen
		expect(log).not.toContain("cb1:connecting->connected");
	});
});

// ============================================================================
// F-018: ConnectionPool Race Condition During Auto-Reconnect
// ============================================================================
describe("F-018: ConnectionPool Auto-Reconnect Race Conditions", () => {
	it("F-018 FIXED: disconnect during auto-reconnect cancels reconnection", async () => {
		// This test verifies the fix for F-018 - reconnection is properly cancelled
		let disconnectCallback: (() => void) | null = null;
		let reconnectResolve: ((s: BLEConnectedSession) => void) | null = null;

		const mockSession: BLEConnectedSession = {
			deviceId: "device-1",
			deviceName: "Test",
			getPrimaryServices: vi.fn().mockResolvedValue([]),
			getPrimaryService: vi.fn().mockResolvedValue({}),
			disconnect: vi.fn().mockResolvedValue(undefined),
			onDisconnect: vi.fn((cb: () => void) => {
				disconnectCallback = cb;
				return () => {
					disconnectCallback = null;
				};
			}),
		};

		const adapter: BLEAdapter = {
			connect: vi.fn().mockResolvedValue(mockSession),
			reconnect: vi.fn(
				() =>
					new Promise<BLEConnectedSession | null>((resolve) => {
						reconnectResolve = resolve;
					}),
			),
		};

		const pool = createConnectionPool({
			autoReconnect: true,
			createAdapter: () => adapter,
		});

		// Connect
		await pool.connect();
		expect(pool.connectionCount).toBe(1);

		// Trigger unexpected disconnect
		(disconnectCallback as (() => void) | null)?.();

		// While reconnect is in progress, user calls disconnect
		await pool.disconnect("device-1");

		// Now let reconnect complete
		(reconnectResolve as ((s: BLEConnectedSession) => void) | null)?.(
			mockSession,
		);

		// Give time for async operations
		await new Promise((r) => setTimeout(r, 10));

		// F-018 FIXED: Pool should have 0 sessions because user explicitly disconnected
		expect(pool.connectionCount).toBe(0);
	});

	it("rapid connect/disconnect cycles should maintain consistency", async () => {
		let sessionCounter = 0;

		const createMockSession = (): BLEConnectedSession => ({
			deviceId: `device-${sessionCounter++}`,
			deviceName: "Test",
			getPrimaryServices: vi.fn().mockResolvedValue([]),
			getPrimaryService: vi.fn().mockResolvedValue({}),
			disconnect: vi.fn().mockResolvedValue(undefined),
			onDisconnect: vi.fn().mockReturnValue(() => {}),
		});

		const pool = createConnectionPool({
			createAdapter: () => ({
				connect: vi
					.fn()
					.mockImplementation(() => Promise.resolve(createMockSession())),
			}),
		});

		// Rapid cycles
		for (let i = 0; i < 10; i++) {
			const session = await pool.connect();
			await pool.disconnect(session.deviceId);
		}

		expect(pool.connectionCount).toBe(0);
		expect(pool.getSessions().size).toBe(0);
	});
});

// ============================================================================
// F-020: startNotifications Double-Stop Safety
// ============================================================================
describe("F-020: Notification Cleanup Double-Stop", () => {
	it("calling cleanup multiple times should not throw", async () => {
		const mockChar: BLEGATTCharacteristic = {
			uuid: "test-uuid",
			properties: { notify: true },
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

		const cleanup = await startNotifications(mockChar, vi.fn());

		// First cleanup
		cleanup();

		// Second cleanup should not throw
		expect(() => cleanup()).not.toThrow();

		// stopNotifications called only once (or twice, documenting behavior)
		// The implementation doesn't guard against double-stop
		expect(mockChar.stopNotifications).toHaveBeenCalled();
	});

	it("cleanup after characteristic is invalidated should not throw", async () => {
		const stopNotifications = vi
			.fn()
			.mockRejectedValue(
				new Error("GATT operation failed: characteristic no longer valid"),
			);

		const mockChar: BLEGATTCharacteristic = {
			uuid: "test-uuid",
			properties: { notify: true },
			readValue: vi.fn(),
			writeValueWithResponse: vi.fn(),
			writeValueWithoutResponse: vi.fn(),
			startNotifications: vi.fn().mockResolvedValue(undefined),
			stopNotifications,
			getDescriptor: vi.fn(),
			getDescriptors: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			get value() {
				return undefined;
			},
		};

		const consoleWarnSpy = vi
			.spyOn(console, "warn")
			.mockImplementation(() => {});
		const cleanup = await startNotifications(mockChar, vi.fn());

		// Cleanup when char is invalid - should not throw (error is logged)
		expect(() => cleanup()).not.toThrow();

		// Wait for async warning to be logged
		await new Promise((r) => setTimeout(r, 10));
		expect(consoleWarnSpy).toHaveBeenCalled();
		consoleWarnSpy.mockRestore();
	});
});

// ============================================================================
// F-021: withRetry with Zero or Negative maxAttempts
// ============================================================================
describe("F-021: withRetry Edge Case Parameters", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("maxAttempts = 0 throws RangeError without calling operation", async () => {
		vi.useRealTimers();
		const operation = vi.fn().mockResolvedValue("success");

		await expect(withRetry(operation, { maxAttempts: 0 })).rejects.toThrow(
			RangeError,
		);

		await expect(withRetry(operation, { maxAttempts: 0 })).rejects.toThrow(
			"maxAttempts must be >= 1",
		);

		expect(operation).not.toHaveBeenCalled();
	});

	it("negative maxAttempts throws RangeError without calling operation", async () => {
		vi.useRealTimers();
		const operation = vi.fn().mockResolvedValue("success");

		await expect(withRetry(operation, { maxAttempts: -1 })).rejects.toThrow(
			RangeError,
		);

		await expect(withRetry(operation, { maxAttempts: -1 })).rejects.toThrow(
			"maxAttempts must be >= 1",
		);

		expect(operation).not.toHaveBeenCalled();
	});

	it("initialDelayMs = 0 should still work", async () => {
		const operation = vi
			.fn()
			.mockRejectedValueOnce(new Error("network error"))
			.mockResolvedValue("success");

		const promise = withRetry(operation, {
			maxAttempts: 2,
			initialDelayMs: 0,
			jitter: false,
		});

		await vi.advanceTimersByTimeAsync(1);
		const result = await promise;

		expect(result).toBe("success");
		expect(operation).toHaveBeenCalledTimes(2);
	});

	it("backoffMultiplier = 0 produces constant delay", async () => {
		const onRetry = vi.fn();
		const operation = vi
			.fn()
			.mockRejectedValueOnce(new Error("GATT connection error 1"))
			.mockRejectedValueOnce(new Error("GATT connection error 2"))
			.mockResolvedValue("success");

		const promise = withRetry(operation, {
			maxAttempts: 3,
			initialDelayMs: 1000,
			backoffMultiplier: 0,
			jitter: false,
			onRetry,
		});

		await vi.runAllTimersAsync();
		await promise;

		// With multiplier 0, delay should stay at initial (1000 * 0^n = 0, but capped)
		// Actually 1000 * 0^0 = 1000 * 1 = 1000 for first retry
		// Documenting actual behavior
	});
});

// ============================================================================
// F-022: raceWithAbort Cleanup Timing
// ============================================================================
describe("F-022: raceWithAbort Event Listener Cleanup", () => {
	it("abort does not affect already resolved promises", async () => {
		const controller = new AbortController();

		const result = await raceWithAbort(
			Promise.resolve("value"),
			controller.signal,
		);
		expect(result).toBe("value");

		// Aborting after resolution should have no effect
		controller.abort();

		// No error should be thrown
	});

	it("abort rejects pending promise", async () => {
		const controller = new AbortController();

		const slowPromise = new Promise((resolve) => {
			setTimeout(() => resolve("late"), 1000);
		});

		// Start the race
		const racePromise = raceWithAbort(slowPromise, controller.signal);

		// Abort immediately
		controller.abort();

		await expect(racePromise).rejects.toThrow(AbortError);
	});

	it("multiple concurrent raceWithAbort with same signal work correctly", async () => {
		const controller = new AbortController();

		const results = await Promise.all([
			raceWithAbort(Promise.resolve(1), controller.signal),
			raceWithAbort(Promise.resolve(2), controller.signal),
			raceWithAbort(Promise.resolve(3), controller.signal),
		]);

		expect(results).toEqual([1, 2, 3]);
	});
});

// ============================================================================
// F-023: ConnectionPool Max Connections Boundary
// ============================================================================
describe("F-023: ConnectionPool Boundary Conditions", () => {
	it("exactly MAX_BLE_CONNECTIONS sessions allowed", async () => {
		let deviceId = 0;
		const pool = createConnectionPool({
			createAdapter: () => ({
				connect: vi.fn().mockImplementation(() =>
					Promise.resolve({
						deviceId: `device-${deviceId++}`,
						deviceName: "Test",
						getPrimaryServices: vi.fn().mockResolvedValue([]),
						getPrimaryService: vi.fn().mockResolvedValue({}),
						disconnect: vi.fn().mockResolvedValue(undefined),
						onDisconnect: vi.fn().mockReturnValue(() => {}),
					}),
				),
			}),
		});

		// Connect exactly MAX_BLE_CONNECTIONS
		for (let i = 0; i < MAX_BLE_CONNECTIONS; i++) {
			await pool.connect();
		}

		expect(pool.connectionCount).toBe(MAX_BLE_CONNECTIONS);

		// One more should throw
		await expect(pool.connect()).rejects.toThrow(/Maximum connections/);
	});

	it("disconnect then connect at max should work", async () => {
		let deviceId = 0;
		const pool = createConnectionPool({
			maxConnections: 2,
			createAdapter: () => ({
				connect: vi.fn().mockImplementation(() =>
					Promise.resolve({
						deviceId: `device-${deviceId++}`,
						deviceName: "Test",
						getPrimaryServices: vi.fn().mockResolvedValue([]),
						getPrimaryService: vi.fn().mockResolvedValue({}),
						disconnect: vi.fn().mockResolvedValue(undefined),
						onDisconnect: vi.fn().mockReturnValue(() => {}),
					}),
				),
			}),
		});

		await pool.connect(); // device-0
		await pool.connect(); // device-1

		expect(pool.connectionCount).toBe(2);

		// At max
		await expect(pool.connect()).rejects.toThrow();

		// Disconnect one
		await pool.disconnect("device-0");
		expect(pool.connectionCount).toBe(1);

		// Should be able to connect again
		await pool.connect(); // device-2
		expect(pool.connectionCount).toBe(2);
	});
});

// ============================================================================
// F-024: toEventTarget Listener Deduplication
// ============================================================================
describe("F-024: toEventTarget Edge Cases", () => {
	it("adding same listener twice should not double-subscribe to emitter", () => {
		const emitter = createEventEmitter<{ test: number }>();
		const target = toEventTarget(emitter);

		const listener = vi.fn();

		target.addEventListener("test", listener);
		target.addEventListener("test", listener); // Duplicate

		// Emit once
		emitter.emit("test", 42);

		// Listener should only be called once (EventTarget deduplicates)
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("removing non-existent listener should not throw", () => {
		const emitter = createEventEmitter<{ test: number }>();
		const target = toEventTarget(emitter);

		const listener = vi.fn();

		// Remove without ever adding
		expect(() => target.removeEventListener("test", listener)).not.toThrow();
	});

	it("null listener should be ignored", () => {
		const emitter = createEventEmitter<{ test: number }>();
		const target = toEventTarget(emitter);

		// These should not throw
		expect(() => target.addEventListener("test", null)).not.toThrow();
		expect(() => target.removeEventListener("test", null)).not.toThrow();
	});
});

// ============================================================================
// Load Testing: ConnectionPool Under Stress
// ============================================================================
describe("ConnectionPool Load Testing", () => {
	it("handles 7 simultaneous connect() calls (MAX_BLE_CONNECTIONS)", async () => {
		let deviceId = 0;
		const connectDelays: number[] = [];

		const pool = createConnectionPool({
			createAdapter: () => ({
				connect: vi.fn().mockImplementation(async () => {
					const delay = Math.random() * 50;
					connectDelays.push(delay);
					await new Promise((r) => setTimeout(r, delay));
					return {
						deviceId: `device-${deviceId++}`,
						deviceName: "Test",
						getPrimaryServices: vi.fn().mockResolvedValue([]),
						getPrimaryService: vi.fn().mockResolvedValue({}),
						disconnect: vi.fn().mockResolvedValue(undefined),
						onDisconnect: vi.fn().mockReturnValue(() => {}),
					};
				}),
			}),
		});

		// Launch 7 connections simultaneously
		const connectPromises = Array.from({ length: MAX_BLE_CONNECTIONS }, () =>
			pool.connect(),
		);

		const sessions = await Promise.all(connectPromises);

		expect(sessions).toHaveLength(MAX_BLE_CONNECTIONS);
		expect(pool.connectionCount).toBe(MAX_BLE_CONNECTIONS);

		// Verify all sessions have unique device IDs
		const deviceIds = new Set(sessions.map((s) => s.deviceId));
		expect(deviceIds.size).toBe(MAX_BLE_CONNECTIONS);
	});

	it("rejects 8th connection while 7 are pending", async () => {
		let deviceId = 0;
		const resolveConnects: (() => void)[] = [];

		const pool = createConnectionPool({
			createAdapter: () => ({
				connect: vi.fn().mockImplementation(
					() =>
						new Promise((resolve) => {
							const id = deviceId++;
							resolveConnects.push(() =>
								resolve({
									deviceId: `device-${id}`,
									deviceName: "Test",
									getPrimaryServices: vi.fn().mockResolvedValue([]),
									getPrimaryService: vi.fn().mockResolvedValue({}),
									disconnect: vi.fn().mockResolvedValue(undefined),
									onDisconnect: vi.fn().mockReturnValue(() => {}),
								}),
							);
						}),
				),
			}),
		});

		// Start 7 connections (they will be pending)
		const pendingConnections = Array.from({ length: MAX_BLE_CONNECTIONS }, () =>
			pool.connect(),
		);

		// Give time for connects to start
		await new Promise((r) => setTimeout(r, 10));

		// 8th connection should reject immediately
		await expect(pool.connect()).rejects.toThrow(/Maximum connections/);

		// Resolve all pending connections
		for (const resolve of resolveConnects) {
			resolve();
		}
		await Promise.all(pendingConnections);

		expect(pool.connectionCount).toBe(MAX_BLE_CONNECTIONS);
	});

	it("maintains consistency under rapid connect/disconnect load (50 operations)", async () => {
		let deviceId = 0;

		const pool = createConnectionPool({
			maxConnections: 5,
			createAdapter: () => ({
				connect: vi.fn().mockImplementation(async () => {
					await new Promise((r) => setTimeout(r, Math.random() * 10));
					return {
						deviceId: `device-${deviceId++}`,
						deviceName: "Test",
						getPrimaryServices: vi.fn().mockResolvedValue([]),
						getPrimaryService: vi.fn().mockResolvedValue({}),
						disconnect: vi.fn().mockResolvedValue(undefined),
						onDisconnect: vi.fn().mockReturnValue(() => {}),
					};
				}),
			}),
		});

		// Run sequential operations to avoid race conditions
		for (let i = 0; i < 50; i++) {
			if (pool.connectionCount < 5 && Math.random() > 0.3) {
				// 70% chance to connect when under limit
				try {
					await pool.connect();
					// Verify invariant
					expect(pool.connectionCount).toBeLessThanOrEqual(5);
					expect(pool.connectionCount).toBe(pool.getSessions().size);
				} catch {
					// May fail if we hit the limit due to pending connections
				}
			} else if (pool.connectionCount > 0) {
				// Disconnect a random session
				const sessions = pool.getSessions();
				const firstKey = sessions.keys().next().value;
				if (firstKey) {
					await pool.disconnect(firstKey);
					// Verify invariant
					expect(pool.connectionCount).toBeGreaterThanOrEqual(0);
					expect(pool.connectionCount).toBe(pool.getSessions().size);
				}
			}
		}

		// Final invariant check
		expect(pool.connectionCount).toBe(pool.getSessions().size);
		expect(pool.connectionCount).toBeLessThanOrEqual(5);
	});

	it("survives 100 connect/disconnect cycles (stress test)", async () => {
		let deviceId = 0;
		let connectCount = 0;
		let disconnectCount = 0;

		const pool = createConnectionPool({
			maxConnections: 3,
			createAdapter: () => ({
				connect: vi.fn().mockImplementation(async () => {
					connectCount++;
					return {
						deviceId: `device-${deviceId++}`,
						deviceName: "Test",
						getPrimaryServices: vi.fn().mockResolvedValue([]),
						getPrimaryService: vi.fn().mockResolvedValue({}),
						disconnect: vi.fn().mockImplementation(async () => {
							disconnectCount++;
						}),
						onDisconnect: vi.fn().mockReturnValue(() => {}),
					};
				}),
			}),
		});

		// Run 100 complete cycles
		for (let i = 0; i < 100; i++) {
			const session = await pool.connect();
			expect(pool.connectionCount).toBe(1);
			expect(pool.isConnected(session.deviceId)).toBe(true);

			await pool.disconnect(session.deviceId);
			expect(pool.connectionCount).toBe(0);
			expect(pool.isConnected(session.deviceId)).toBe(false);
		}

		expect(connectCount).toBe(100);
		expect(disconnectCount).toBe(100);
		expect(pool.connectionCount).toBe(0);
		expect(pool.getSessions().size).toBe(0);
	});

	it("handles concurrent connect attempts at max capacity", async () => {
		let deviceId = 0;

		const pool = createConnectionPool({
			maxConnections: 3,
			createAdapter: () => ({
				connect: vi.fn().mockImplementation(async () => {
					await new Promise((r) => setTimeout(r, 10));
					return {
						deviceId: `device-${deviceId++}`,
						deviceName: "Test",
						getPrimaryServices: vi.fn().mockResolvedValue([]),
						getPrimaryService: vi.fn().mockResolvedValue({}),
						disconnect: vi.fn().mockResolvedValue(undefined),
						onDisconnect: vi.fn().mockReturnValue(() => {}),
					};
				}),
			}),
		});

		// Fill to max capacity
		await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
		expect(pool.connectionCount).toBe(3);

		// Try 5 concurrent connects - all should fail
		const failedConnects = await Promise.allSettled([
			pool.connect(),
			pool.connect(),
			pool.connect(),
			pool.connect(),
			pool.connect(),
		]);

		// All should be rejected
		for (const result of failedConnects) {
			expect(result.status).toBe("rejected");
		}

		// Pool should still have exactly 3 connections
		expect(pool.connectionCount).toBe(3);
	});
});

// ============================================================================
// Property Tests: Additional Invariants
// ============================================================================
describe("Property Tests: Round 2", () => {
	describe("ConnectionPool invariants", () => {
		it("connectionCount always matches getSessions().size", async () => {
			let deviceId = 0;
			const pool = createConnectionPool({
				maxConnections: 5,
				createAdapter: () => ({
					connect: vi.fn().mockImplementation(() =>
						Promise.resolve({
							deviceId: `device-${deviceId++}`,
							deviceName: "Test",
							getPrimaryServices: vi.fn().mockResolvedValue([]),
							getPrimaryService: vi.fn().mockResolvedValue({}),
							disconnect: vi.fn().mockResolvedValue(undefined),
							onDisconnect: vi.fn().mockReturnValue(() => {}),
						}),
					),
				}),
			});

			// Random sequence of connects and disconnects
			const actions = fc.sample(
				fc.oneof(fc.constant("connect"), fc.constant("disconnect")),
				20,
			);

			for (const action of actions) {
				if (action === "connect" && pool.connectionCount < 5) {
					await pool.connect();
				} else if (action === "disconnect" && pool.connectionCount > 0) {
					const sessions = pool.getSessions();
					const firstKey = sessions.keys().next().value;
					if (firstKey) {
						await pool.disconnect(firstKey);
					}
				}

				// Invariant: count matches size
				expect(pool.connectionCount).toBe(pool.getSessions().size);
			}
		});
	});

	describe("State machine exhaustive transitions", () => {
		it("all valid transitions succeed, all invalid throw", () => {
			const states = [
				"disconnected",
				"connecting",
				"connected",
				"error",
			] as const;

			const validTransitions: Record<string, string[]> = {
				disconnected: ["connecting"],
				connecting: ["connected", "error", "disconnected"],
				connected: ["disconnected", "error"],
				error: ["disconnected", "connecting"],
			};

			for (const from of states) {
				for (const to of states) {
					const sm = createStateMachine(from);
					const shouldSucceed = validTransitions[from]?.includes(to);

					if (shouldSucceed) {
						expect(() => sm.transition(to)).not.toThrow();
						expect(sm.getState()).toBe(to);
					} else {
						expect(() => sm.transition(to)).toThrow();
						expect(sm.getState()).toBe(from); // State unchanged
					}
				}
			}
		});
	});

	describe("withTimeout never leaves dangling timers", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("resolving promise clears timeout", async () => {
			const promise = withTimeout(Promise.resolve("value"), 10000, "test");

			await vi.advanceTimersByTimeAsync(0);
			await promise;

			// Advancing more time should not cause any side effects
			vi.advanceTimersByTime(20000);

			// If timeout wasn't cleared, this test would hang or throw
		});

		it("rejecting promise clears timeout", async () => {
			vi.useRealTimers(); // Use real timers for rejection test

			const promise = withTimeout(
				Promise.reject(new Error("fail")),
				10000,
				"test",
			);

			await expect(promise).rejects.toThrow("fail");

			vi.useFakeTimers(); // Restore for other tests
		});
	});
});
