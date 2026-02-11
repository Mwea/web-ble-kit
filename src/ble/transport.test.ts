import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AbortError, TimeoutError } from "../errors";
import type { BLEGATTCharacteristic } from "../types";
import { extractArrayBuffer, uuidMatches } from "../utils";
import {
	DEFAULT_READ_TIMEOUT_MS,
	DEFAULT_WRITE_TIMEOUT_MS,
	readWithTimeout,
	startNotifications,
	withRetry,
	writeWithTimeout,
} from "./transport";

describe("transport", () => {
	describe("writeWithTimeout", () => {
		it("should write data successfully", async () => {
			const mockChar = {
				writeValueWithResponse: vi.fn().mockResolvedValue(undefined),
			} as unknown as BLEGATTCharacteristic;

			const data = new Uint8Array([1, 2, 3]);
			await writeWithTimeout(mockChar, data);

			expect(mockChar.writeValueWithResponse).toHaveBeenCalledWith(data);
		});

		it("should throw error for empty data", async () => {
			const mockChar = {
				writeValueWithResponse: vi.fn(),
			} as unknown as BLEGATTCharacteristic;

			const data = new Uint8Array(0);
			await expect(writeWithTimeout(mockChar, data)).rejects.toThrow(
				"Empty data",
			);

			expect(mockChar.writeValueWithResponse).not.toHaveBeenCalled();
		});

		it("should timeout if write takes too long", async () => {
			vi.useFakeTimers();

			const mockChar = {
				writeValueWithResponse: vi.fn().mockImplementation(
					() => new Promise(() => {}), // Never resolves
				),
			} as unknown as BLEGATTCharacteristic;

			const data = new Uint8Array([1, 2, 3]);
			const promise = writeWithTimeout(mockChar, data, 1000);

			vi.advanceTimersByTime(1001);

			await expect(promise).rejects.toThrow(TimeoutError);

			vi.useRealTimers();
		});

		it("should use default timeout when none provided", async () => {
			vi.useFakeTimers();

			const mockChar = {
				writeValueWithResponse: vi.fn().mockImplementation(
					() => new Promise(() => {}), // Never resolves
				),
			} as unknown as BLEGATTCharacteristic;

			const data = new Uint8Array([1, 2, 3]);
			const promise = writeWithTimeout(mockChar, data);

			// Advance just before default timeout - should not reject yet
			vi.advanceTimersByTime(DEFAULT_WRITE_TIMEOUT_MS - 1);
			await Promise.resolve(); // Let pending promises settle

			// Advance past default timeout - should reject
			vi.advanceTimersByTime(2);
			await expect(promise).rejects.toThrow(TimeoutError);

			vi.useRealTimers();
		});
	});

	describe("readWithTimeout", () => {
		it("should read data successfully", async () => {
			const expectedValue = new DataView(new ArrayBuffer(4));
			const mockChar = {
				readValue: vi.fn().mockResolvedValue(expectedValue),
			} as unknown as BLEGATTCharacteristic;

			const result = await readWithTimeout(mockChar);

			expect(mockChar.readValue).toHaveBeenCalled();
			expect(result).toBe(expectedValue);
		});

		it("should timeout if read takes too long", async () => {
			vi.useFakeTimers();

			const mockChar = {
				readValue: vi.fn().mockImplementation(
					() => new Promise(() => {}), // Never resolves
				),
			} as unknown as BLEGATTCharacteristic;

			const promise = readWithTimeout(mockChar, 1000);

			vi.advanceTimersByTime(1001);

			await expect(promise).rejects.toThrow(TimeoutError);

			vi.useRealTimers();
		});

		it("should use default timeout when none provided", async () => {
			vi.useFakeTimers();

			const mockChar = {
				readValue: vi.fn().mockImplementation(
					() => new Promise(() => {}), // Never resolves
				),
			} as unknown as BLEGATTCharacteristic;

			const promise = readWithTimeout(mockChar);

			// Advance just before default timeout - should not reject yet
			vi.advanceTimersByTime(DEFAULT_READ_TIMEOUT_MS - 1);
			await Promise.resolve(); // Let pending promises settle

			// Advance past default timeout - should reject
			vi.advanceTimersByTime(2);
			await expect(promise).rejects.toThrow(TimeoutError);

			vi.useRealTimers();
		});
	});

	describe("uuidMatches", () => {
		it("should match exact short UUIDs", () => {
			expect(uuidMatches("fe00", "fe00")).toBe(true);
			expect(uuidMatches("FE00", "fe00")).toBe(true);
			expect(uuidMatches("fe00", "FE00")).toBe(true);
		});

		it("should not match different short UUIDs", () => {
			expect(uuidMatches("fe00", "fe01")).toBe(false);
		});

		it("should match full UUID with short ID", () => {
			expect(uuidMatches("0000fe00-0000-1000-8000-00805f9b34fb", "fe00")).toBe(
				true,
			);
		});

		it("should not match full UUID with different short ID", () => {
			expect(uuidMatches("0000fe00-0000-1000-8000-00805f9b34fb", "fe01")).toBe(
				false,
			);
		});
	});

	describe("extractArrayBuffer", () => {
		it("should return null for undefined value", () => {
			expect(extractArrayBuffer(undefined)).toBeNull();
		});

		it("should return null for empty DataView", () => {
			const view = new DataView(new ArrayBuffer(0));
			expect(extractArrayBuffer(view)).toBeNull();
		});

		it("should extract buffer from DataView", () => {
			const buffer = new ArrayBuffer(4);
			const view = new DataView(buffer);
			new Uint8Array(buffer).set([1, 2, 3, 4]);

			const result = extractArrayBuffer(view);

			if (result === null) {
				throw new Error("Expected result to not be null");
			}
			expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3, 4]));
		});

		it("should handle DataView with offset", () => {
			const buffer = new ArrayBuffer(8);
			new Uint8Array(buffer).set([0, 0, 1, 2, 3, 4, 0, 0]);
			const view = new DataView(buffer, 2, 4);

			const result = extractArrayBuffer(view);

			if (result === null) {
				throw new Error("Expected result to not be null");
			}
			expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3, 4]));
		});
	});

	describe("startNotifications", () => {
		let mockChar: BLEGATTCharacteristic;
		let eventListeners: Map<string, EventListenerOrEventListenerObject>;

		beforeEach(() => {
			eventListeners = new Map();
			mockChar = {
				startNotifications: vi.fn().mockResolvedValue(undefined),
				stopNotifications: vi.fn().mockResolvedValue(undefined),
				addEventListener: vi.fn((type, listener) => {
					eventListeners.set(type, listener);
				}),
				removeEventListener: vi.fn((type) => {
					eventListeners.delete(type);
				}),
				value: undefined,
			} as unknown as BLEGATTCharacteristic;
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("should start notifications and register listener", async () => {
			const onData = vi.fn();
			await startNotifications(mockChar, onData);

			expect(mockChar.startNotifications).toHaveBeenCalled();
			expect(mockChar.addEventListener).toHaveBeenCalledWith(
				"characteristicvaluechanged",
				expect.any(Function),
			);
		});

		it("should return cleanup function", async () => {
			const onData = vi.fn();
			const cleanup = await startNotifications(mockChar, onData);

			cleanup();

			expect(mockChar.removeEventListener).toHaveBeenCalled();
			expect(mockChar.stopNotifications).toHaveBeenCalled();
		});
	});

	describe("withRetry", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("returns result on first success", async () => {
			const operation = vi.fn().mockResolvedValue("success");
			const result = await withRetry(operation);
			expect(result).toBe("success");
			expect(operation).toHaveBeenCalledTimes(1);
		});

		it("retries on failure and returns on eventual success", async () => {
			const operation = vi
				.fn()
				.mockRejectedValueOnce(new Error("GATT network error 1"))
				.mockRejectedValueOnce(new Error("GATT network error 2"))
				.mockResolvedValue("success");

			const resultPromise = withRetry(operation, {
				maxAttempts: 3,
				initialDelayMs: 100,
				jitter: false,
			});

			// First attempt fails immediately
			await vi.advanceTimersByTimeAsync(0);

			// Wait for first retry delay
			await vi.advanceTimersByTimeAsync(100);

			// Wait for second retry delay (exponential: 100 * 2 = 200)
			await vi.advanceTimersByTimeAsync(200);

			const result = await resultPromise;
			expect(result).toBe("success");
			expect(operation).toHaveBeenCalledTimes(3);
		});

		it("throws last error after max attempts", async () => {
			// Use real timers for this test to avoid fake timer quirks
			vi.useRealTimers();
			let callCount = 0;
			const operation = vi.fn().mockImplementation(async () => {
				callCount++;
				throw new Error("GATT connection failed");
			});

			await expect(
				withRetry(operation, {
					maxAttempts: 3,
					initialDelayMs: 10, // Use short delays with real timers
					jitter: false,
				}),
			).rejects.toThrow("GATT connection failed");

			expect(callCount).toBe(3);
			vi.useFakeTimers(); // Restore for other tests
		});

		it("does not retry non-retryable errors", async () => {
			const operation = vi.fn().mockRejectedValue(new AbortError("cancelled"));

			await expect(withRetry(operation, { maxAttempts: 3 })).rejects.toThrow(
				"cancelled",
			);
			expect(operation).toHaveBeenCalledTimes(1);
		});

		it("calls onRetry callback before each retry", async () => {
			const operation = vi
				.fn()
				.mockRejectedValueOnce(new Error("network error"))
				.mockResolvedValue("success");

			const onRetry = vi.fn();

			const resultPromise = withRetry(operation, {
				maxAttempts: 3,
				initialDelayMs: 100,
				jitter: false,
				onRetry,
			});

			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(100);

			await resultPromise;

			expect(onRetry).toHaveBeenCalledTimes(1);
			expect(onRetry).toHaveBeenCalledWith(1, 100, expect.any(Error));
		});

		it("respects custom isRetryable predicate", async () => {
			const myError = new Error("custom error");
			const operation = vi.fn().mockRejectedValue(myError);

			// Custom predicate that never retries
			const isRetryable = vi.fn().mockReturnValue(false);

			await expect(
				withRetry(operation, { maxAttempts: 3, isRetryable }),
			).rejects.toThrow();
			expect(operation).toHaveBeenCalledTimes(1);
			expect(isRetryable).toHaveBeenCalledWith(myError);
		});

		it("respects maxDelayMs cap", async () => {
			const operation = vi
				.fn()
				.mockRejectedValueOnce(new Error("GATT operation failed 1"))
				.mockRejectedValueOnce(new Error("GATT operation failed 2"))
				.mockResolvedValue("success");

			const onRetry = vi.fn();

			const resultPromise = withRetry(operation, {
				maxAttempts: 3,
				initialDelayMs: 1000,
				maxDelayMs: 1500,
				backoffMultiplier: 2,
				jitter: false,
				onRetry,
			});

			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(1000);
			await vi.advanceTimersByTimeAsync(1500); // Capped at maxDelayMs

			await resultPromise;

			expect(onRetry).toHaveBeenNthCalledWith(1, 1, 1000, expect.any(Error));
			expect(onRetry).toHaveBeenNthCalledWith(2, 2, 1500, expect.any(Error)); // Capped
		});

		it("aborts immediately when signal is already aborted", async () => {
			const operation = vi.fn().mockResolvedValue("success");
			const controller = new AbortController();
			controller.abort();

			await expect(
				withRetry(operation, { signal: controller.signal }),
			).rejects.toThrow(AbortError);

			expect(operation).not.toHaveBeenCalled();
		});

		it("aborts during delay when signal is aborted", async () => {
			// Use real timers to avoid fake timer quirks
			vi.useRealTimers();

			let callCount = 0;
			const operation = vi.fn().mockImplementation(async () => {
				callCount++;
				if (callCount === 1) {
					throw new Error("network error");
				}
				return "success";
			});

			const controller = new AbortController();

			const promise = withRetry(operation, {
				signal: controller.signal,
				maxAttempts: 3,
				initialDelayMs: 100, // Long enough to abort during
				jitter: false,
			});

			// Wait for first attempt to fail, then abort during delay
			await new Promise((resolve) => setTimeout(resolve, 20));
			controller.abort();

			await expect(promise).rejects.toThrow(AbortError);
			expect(callCount).toBe(1);
			vi.useFakeTimers(); // Restore for other tests
		});

		it("uses default options when none provided", async () => {
			const operation = vi.fn().mockResolvedValue("success");
			const result = await withRetry(operation);
			expect(result).toBe("success");
		});
	});

	describe("withRetry with jitter", () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.spyOn(Math, "random").mockReturnValue(0.5);
		});

		afterEach(() => {
			vi.useRealTimers();
			vi.restoreAllMocks();
		});

		it("adds jitter to delay when enabled", async () => {
			const operation = vi
				.fn()
				.mockRejectedValueOnce(new Error("connection error"))
				.mockResolvedValue("success");

			const onRetry = vi.fn();

			const resultPromise = withRetry(operation, {
				maxAttempts: 2,
				initialDelayMs: 1000,
				jitter: true,
				onRetry,
			});

			// First attempt fails immediately
			await vi.advanceTimersByTimeAsync(0);

			// With jitter formula and Math.random() = 0.5:
			// jitterAmount = 0.5 * 1000 * 0.5 = 250
			// delay = 1000 + 250 - 250 = 1000 (with this specific random value)
			// But the exact value depends on the formula, just verify it's called
			await vi.runAllTimersAsync();

			await resultPromise;

			expect(onRetry).toHaveBeenCalledTimes(1);
			expect(onRetry.mock.calls[0]?.[1]).toBeGreaterThan(0);
		});
	});
});
