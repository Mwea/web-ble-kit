/**
 * Tests for poll-manager
 * Covers: C-002
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPollManager } from "./poll-manager";

describe("createPollManager", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("basic lifecycle", () => {
		it("isPolling returns false initially", () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 100,
				onError: vi.fn(),
			});

			expect(manager.isPolling()).toBe(false);
		});

		it("isPolling returns true after start", () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 100,
				onError: vi.fn(),
			});

			manager.start({ data: "test" });
			expect(manager.isPolling()).toBe(true);
		});

		it("isPolling returns false after stop", () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 100,
				onError: vi.fn(),
			});

			manager.start({ data: "test" });
			manager.stop();
			expect(manager.isPolling()).toBe(false);
		});

		it("calls pollFn at specified interval", async () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 100,
				onError: vi.fn(),
			});

			manager.start({ data: "test" });

			expect(pollFn).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(100);
			expect(pollFn).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(100);
			expect(pollFn).toHaveBeenCalledTimes(2);

			await vi.advanceTimersByTimeAsync(100);
			expect(pollFn).toHaveBeenCalledTimes(3);

			manager.stop();
		});

		it("passes context to pollFn", async () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager<{ data: string }>(pollFn, {
				defaultIntervalMs: 100,
				onError: vi.fn(),
			});

			const context = { data: "test-value" };
			manager.start(context);

			await vi.advanceTimersByTimeAsync(100);
			expect(pollFn).toHaveBeenCalledWith(context);

			manager.stop();
		});

		it("stops calling pollFn after stop", async () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 100,
				onError: vi.fn(),
			});

			manager.start({ data: "test" });

			await vi.advanceTimersByTimeAsync(100);
			expect(pollFn).toHaveBeenCalledTimes(1);

			manager.stop();

			await vi.advanceTimersByTimeAsync(300);
			expect(pollFn).toHaveBeenCalledTimes(1);
		});

		it("uses custom interval from start options", async () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 1000,
				onError: vi.fn(),
			});

			manager.start({ data: "test" }, { intervalMs: 50 });

			await vi.advanceTimersByTimeAsync(50);
			expect(pollFn).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(50);
			expect(pollFn).toHaveBeenCalledTimes(2);

			manager.stop();
		});
	});

	describe("error handling", () => {
		it("calls onError when pollFn throws", async () => {
			const error = new Error("poll failed");
			const pollFn = vi.fn().mockRejectedValue(error);
			const onError = vi.fn();
			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 100,
				onError,
			});

			manager.start({ data: "test" });

			await vi.advanceTimersByTimeAsync(100);
			expect(onError).toHaveBeenCalledWith(error);

			manager.stop();
		});

		it("converts non-Error to Error", async () => {
			const pollFn = vi.fn().mockRejectedValue("string error");
			const onError = vi.fn();
			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 100,
				onError,
			});

			manager.start({ data: "test" });

			await vi.advanceTimersByTimeAsync(100);
			expect(onError).toHaveBeenCalledWith(expect.any(Error));
			expect(onError.mock.calls[0]?.[0].message).toBe("string error");

			manager.stop();
		});

		it("stops after maxConsecutiveErrors", async () => {
			const pollFn = vi.fn().mockRejectedValue(new Error("fail"));
			const onError = vi.fn();
			const consoleWarnSpy = vi
				.spyOn(console, "warn")
				.mockImplementation(() => {});

			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 100,
				onError,
				maxConsecutiveErrors: 3,
			});

			manager.start({ data: "test" });

			// First two errors
			await vi.advanceTimersByTimeAsync(100);
			expect(manager.isPolling()).toBe(true);
			await vi.advanceTimersByTimeAsync(100);
			expect(manager.isPolling()).toBe(true);

			// Third error stops polling
			await vi.advanceTimersByTimeAsync(100);
			expect(manager.isPolling()).toBe(false);
			expect(consoleWarnSpy).toHaveBeenCalledWith(
				expect.stringContaining("Too many consecutive errors"),
			);

			consoleWarnSpy.mockRestore();
		});

		it("resets error count on success", async () => {
			let callCount = 0;
			const pollFn = vi.fn().mockImplementation(async () => {
				callCount++;
				if (callCount === 1 || callCount === 2) {
					throw new Error("fail");
				}
				// Third call succeeds
			});
			const onError = vi.fn();

			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 100,
				onError,
				maxConsecutiveErrors: 3,
			});

			manager.start({ data: "test" });

			// Two failures
			await vi.advanceTimersByTimeAsync(100);
			await vi.advanceTimersByTimeAsync(100);
			expect(onError).toHaveBeenCalledTimes(2);

			// One success
			await vi.advanceTimersByTimeAsync(100);
			expect(manager.isPolling()).toBe(true);

			// Continue polling
			await vi.advanceTimersByTimeAsync(100);
			expect(manager.isPolling()).toBe(true);

			manager.stop();
		});

		it("uses default maxConsecutiveErrors of 3", async () => {
			const pollFn = vi.fn().mockRejectedValue(new Error("fail"));
			const consoleWarnSpy = vi
				.spyOn(console, "warn")
				.mockImplementation(() => {});

			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 100,
				onError: vi.fn(),
				// No maxConsecutiveErrors specified
			});

			manager.start({ data: "test" });

			await vi.advanceTimersByTimeAsync(100);
			await vi.advanceTimersByTimeAsync(100);
			expect(manager.isPolling()).toBe(true);

			await vi.advanceTimersByTimeAsync(100);
			expect(manager.isPolling()).toBe(false);

			consoleWarnSpy.mockRestore();
		});
	});

	describe("restart behavior", () => {
		it("calling start while running restarts polling", async () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 100,
				onError: vi.fn(),
			});

			const context1 = { id: 1 };
			const context2 = { id: 2 };

			manager.start(context1);
			await vi.advanceTimersByTimeAsync(100);
			expect(pollFn).toHaveBeenLastCalledWith(context1);

			// Restart with new context
			manager.start(context2);
			await vi.advanceTimersByTimeAsync(100);
			expect(pollFn).toHaveBeenLastCalledWith(context2);

			manager.stop();
		});

		it("old session does not interfere after restart", async () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 100,
				onError: vi.fn(),
			});

			manager.start({ id: 1 });
			manager.start({ id: 2 });

			await vi.advanceTimersByTimeAsync(100);
			// Should only have been called with context2
			expect(pollFn).toHaveBeenCalledTimes(1);
			expect(pollFn).toHaveBeenCalledWith({ id: 2 });

			manager.stop();
		});
	});

	describe("context handling", () => {
		it("handles object context", () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 100,
				onError: vi.fn(),
			});

			expect(() => manager.start({ data: "test" })).not.toThrow();
			manager.stop();
		});

		it("handles primitive context (number)", async () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager<number>(pollFn, {
				defaultIntervalMs: 100,
				onError: vi.fn(),
			});

			// Should not throw even though primitives cannot be WeakRef'd
			expect(() => manager.start(42)).not.toThrow();

			await vi.advanceTimersByTimeAsync(100);
			expect(pollFn).toHaveBeenCalledWith(42);

			manager.stop();
		});

		it("handles null context", async () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager<null>(pollFn, {
				defaultIntervalMs: 100,
				onError: vi.fn(),
			});

			// null cannot be WeakRef'd but should fallback gracefully
			expect(() => manager.start(null)).not.toThrow();

			await vi.advanceTimersByTimeAsync(100);
			expect(pollFn).toHaveBeenCalledWith(null);

			manager.stop();
		});

		it("handles function context", async () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager<() => void>(pollFn, {
				defaultIntervalMs: 100,
				onError: vi.fn(),
			});

			const callback = () => {};
			manager.start(callback);

			await vi.advanceTimersByTimeAsync(100);
			expect(pollFn).toHaveBeenCalledWith(callback);

			manager.stop();
		});
	});

	describe("session ID management", () => {
		it("handles many start/stop cycles", () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 100,
				onError: vi.fn(),
			});

			for (let i = 0; i < 1000; i++) {
				manager.start({ id: i });
				manager.stop();
			}

			expect(manager.isPolling()).toBe(false);
		});

		it("stop is idempotent", () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 100,
				onError: vi.fn(),
			});

			manager.start({ data: "test" });
			manager.stop();
			manager.stop();
			manager.stop();

			expect(manager.isPolling()).toBe(false);
		});
	});

	describe("edge cases", () => {
		it("stop before any start is safe", () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 100,
				onError: vi.fn(),
			});

			expect(() => manager.stop()).not.toThrow();
			expect(manager.isPolling()).toBe(false);
		});

		it("handles very small intervals", async () => {
			const pollFn = vi.fn().mockResolvedValue(undefined);
			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 1,
				onError: vi.fn(),
			});

			manager.start({ data: "test" });

			await vi.advanceTimersByTimeAsync(10);
			expect(pollFn.mock.calls.length).toBeGreaterThanOrEqual(5);

			manager.stop();
		});

		it("handles pollFn that takes longer than interval", async () => {
			let resolveDelayed: (() => void) | undefined;
			const pollFn = vi.fn().mockImplementation(() => {
				return new Promise<void>((resolve) => {
					resolveDelayed = resolve;
				});
			});
			const manager = createPollManager(pollFn, {
				defaultIntervalMs: 100,
				onError: vi.fn(),
			});

			manager.start({ data: "test" });

			// First poll starts
			await vi.advanceTimersByTimeAsync(100);
			expect(pollFn).toHaveBeenCalledTimes(1);

			// Second poll starts while first is still running
			await vi.advanceTimersByTimeAsync(100);
			expect(pollFn).toHaveBeenCalledTimes(2);

			// Resolve first
			resolveDelayed?.();

			manager.stop();
		});
	});
});
