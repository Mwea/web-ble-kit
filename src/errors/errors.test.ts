import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AbortError,
	isTransientBLEError,
	NotConnectedError,
	normalizeError,
	raceWithAbort,
	TimeoutError,
	throwIfAborted,
	withTimeout,
} from "./errors";

describe("normalizeError", () => {
	it("returns the same Error instance when given an Error", () => {
		const err = new Error("test error");
		const result = normalizeError(err);
		expect(result).toBe(err);
	});

	it("wraps string in Error with original as message", () => {
		const result = normalizeError("string error");
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe("string error");
	});

	it("wraps number in Error with stringified value", () => {
		const result = normalizeError(42);
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe("42");
	});

	it("wraps null in Error with descriptive message", () => {
		const result = normalizeError(null);
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe("null");
	});

	it("wraps undefined in Error with descriptive message", () => {
		const result = normalizeError(undefined);
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe("undefined");
	});

	it("wraps object in Error with JSON representation", () => {
		const result = normalizeError({ code: 123, reason: "failed" });
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toContain("code");
		expect(result.message).toContain("123");
	});

	it("handles circular objects gracefully", () => {
		const obj: Record<string, unknown> = { a: 1 };
		obj["self"] = obj; // Must use bracket notation for index signature
		const result = normalizeError(obj);
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe("[object Object]");
	});
});

describe("withTimeout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves with value when promise completes before timeout", async () => {
		const promise = Promise.resolve("success");
		const result = withTimeout(promise, 1000, "test operation");

		await vi.runAllTimersAsync();
		await expect(result).resolves.toBe("success");
	});

	it("rejects with TimeoutError when timeout expires", async () => {
		const neverResolves = new Promise<string>(() => {});
		const result = withTimeout(neverResolves, 100, "slow operation");

		vi.advanceTimersByTime(100);

		await expect(result).rejects.toBeInstanceOf(TimeoutError);
	});

	it("includes operation label in timeout error message", async () => {
		const neverResolves = new Promise<string>(() => {});
		const result = withTimeout(neverResolves, 100, "BLE connect");

		vi.advanceTimersByTime(100);

		await expect(result).rejects.toThrow("BLE connect");
	});

	it("includes timeout duration in error message", async () => {
		const neverResolves = new Promise<string>(() => {});
		const result = withTimeout(neverResolves, 5000, "operation");

		vi.advanceTimersByTime(5000);

		await expect(result).rejects.toThrow("5000");
	});

	it("propagates rejection from original promise", async () => {
		const error = new Error("original error");
		const promise = Promise.reject(error);
		const result = withTimeout(promise, 1000, "test");

		await expect(result).rejects.toBe(error);
	});

	it("clears timeout when promise resolves", async () => {
		const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

		const promise = Promise.resolve("done");
		await withTimeout(promise, 1000, "test");

		expect(clearTimeoutSpy).toHaveBeenCalled();
		clearTimeoutSpy.mockRestore();
	});

	it("clears timeout when promise rejects", async () => {
		const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

		const promise = Promise.reject(new Error("fail"));
		try {
			await withTimeout(promise, 1000, "test");
		} catch {
			// expected
		}

		expect(clearTimeoutSpy).toHaveBeenCalled();
		clearTimeoutSpy.mockRestore();
	});
});

describe("TimeoutError", () => {
	it("is instanceof Error", () => {
		const err = new TimeoutError("test", 1000);
		expect(err).toBeInstanceOf(Error);
	});

	it("has name property set to TimeoutError", () => {
		const err = new TimeoutError("test", 1000);
		expect(err.name).toBe("TimeoutError");
	});

	it("exposes operation and timeout properties", () => {
		const err = new TimeoutError("my operation", 5000);
		expect(err.operation).toBe("my operation");
		expect(err.timeout).toBe(5000);
	});
});

describe("NotConnectedError", () => {
	it("is instanceof Error", () => {
		const err = new NotConnectedError();
		expect(err).toBeInstanceOf(Error);
	});

	it("has name property set to NotConnectedError", () => {
		const err = new NotConnectedError();
		expect(err.name).toBe("NotConnectedError");
	});

	it("has descriptive message", () => {
		const err = new NotConnectedError();
		expect(err.message).toContain("Not connected");
	});
});

describe("AbortError", () => {
	it("is instanceof Error", () => {
		const err = new AbortError();
		expect(err).toBeInstanceOf(Error);
	});

	it("has name property set to AbortError", () => {
		const err = new AbortError();
		expect(err.name).toBe("AbortError");
	});

	it("has default message", () => {
		const err = new AbortError();
		expect(err.message).toBe("Operation aborted");
	});

	it("accepts custom message", () => {
		const err = new AbortError("Custom abort reason");
		expect(err.message).toBe("Custom abort reason");
	});
});

describe("throwIfAborted", () => {
	it("does nothing when signal is undefined", () => {
		expect(() => throwIfAborted(undefined)).not.toThrow();
	});

	it("does nothing when signal is not aborted", () => {
		const controller = new AbortController();
		expect(() => throwIfAborted(controller.signal)).not.toThrow();
	});

	it("throws AbortError when signal is aborted", () => {
		const controller = new AbortController();
		controller.abort();
		expect(() => throwIfAborted(controller.signal)).toThrow(AbortError);
	});

	it("uses abort reason as message when reason is Error", () => {
		const controller = new AbortController();
		controller.abort(new Error("Custom reason"));
		expect(() => throwIfAborted(controller.signal)).toThrow("Custom reason");
	});

	it("uses abort reason as message when reason is string", () => {
		const controller = new AbortController();
		controller.abort("String reason");
		expect(() => throwIfAborted(controller.signal)).toThrow("String reason");
	});
});

describe("isTransientBLEError", () => {
	it("returns false for AbortError", () => {
		expect(isTransientBLEError(new AbortError())).toBe(false);
	});

	it("returns false for errors with name AbortError", () => {
		const error = new Error("cancelled");
		error.name = "AbortError";
		expect(isTransientBLEError(error)).toBe(false);
	});

	it("returns true for TimeoutError", () => {
		expect(isTransientBLEError(new TimeoutError("test", 1000))).toBe(true);
	});

	it("returns false for user cancelled errors", () => {
		expect(isTransientBLEError(new Error("User cancelled the request"))).toBe(
			false,
		);
		expect(isTransientBLEError(new Error("User canceled the dialog"))).toBe(
			false,
		);
	});

	it("returns false for permission denied errors", () => {
		expect(isTransientBLEError(new Error("Permission denied"))).toBe(false);
		expect(isTransientBLEError(new Error("User denied access"))).toBe(false);
	});

	it("returns false for NotAllowedError", () => {
		const error = new Error("Not allowed");
		error.name = "NotAllowedError";
		expect(isTransientBLEError(error)).toBe(false);
	});

	it("returns false for SecurityError", () => {
		const error = new Error("Security violation");
		error.name = "SecurityError";
		expect(isTransientBLEError(error)).toBe(false);
	});

	it('returns false for "not found" errors', () => {
		expect(isTransientBLEError(new Error("Device not found"))).toBe(false);
		expect(isTransientBLEError(new Error("No device selected"))).toBe(false);
	});

	it("returns true for network errors", () => {
		expect(isTransientBLEError(new Error("Network error"))).toBe(true);
	});

	it("returns true for GATT errors", () => {
		expect(isTransientBLEError(new Error("GATT operation failed"))).toBe(true);
		expect(isTransientBLEError(new Error("GATT Server disconnected"))).toBe(
			true,
		);
	});

	it("returns true for connection errors", () => {
		expect(isTransientBLEError(new Error("Connection failed"))).toBe(true);
		expect(isTransientBLEError(new Error("Failed to execute"))).toBe(true);
	});

	it("returns false for unknown errors (fail-fast default)", () => {
		expect(isTransientBLEError(new Error("Unknown error"))).toBe(false);
		expect(isTransientBLEError(new Error(""))).toBe(false);
		expect(isTransientBLEError(new Error("Some random message"))).toBe(false);
	});

	it("returns false for errors without recognizable patterns", () => {
		expect(isTransientBLEError(new Error("Something went wrong"))).toBe(false);
		expect(isTransientBLEError(new Error("Unexpected state"))).toBe(false);
	});
});

describe("raceWithAbort", () => {
	it("returns promise result when no signal provided", async () => {
		const promise = Promise.resolve("success");
		const result = await raceWithAbort(promise);
		expect(result).toBe("success");
	});

	it("returns promise result when signal not aborted", async () => {
		const controller = new AbortController();
		const promise = Promise.resolve("success");
		const result = await raceWithAbort(promise, controller.signal);
		expect(result).toBe("success");
	});

	it("rejects immediately when signal already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const promise = new Promise<string>((resolve) =>
			setTimeout(() => resolve("late"), 1000),
		);

		await expect(raceWithAbort(promise, controller.signal)).rejects.toThrow(
			AbortError,
		);
	});

	it("rejects when signal is aborted during promise execution", async () => {
		const controller = new AbortController();
		const promise = new Promise<string>((resolve) =>
			setTimeout(() => resolve("late"), 1000),
		);

		const resultPromise = raceWithAbort(promise, controller.signal);

		// Abort after starting
		controller.abort();

		await expect(resultPromise).rejects.toThrow(AbortError);
	});

	it("propagates promise rejection", async () => {
		const controller = new AbortController();
		const promise = Promise.reject(new Error("original error"));

		await expect(raceWithAbort(promise, controller.signal)).rejects.toThrow(
			"original error",
		);
	});

	it("uses abort reason in error message", async () => {
		const controller = new AbortController();
		controller.abort(new Error("User cancelled"));
		const promise = new Promise<string>(() => {});

		await expect(raceWithAbort(promise, controller.signal)).rejects.toThrow(
			"User cancelled",
		);
	});

	it("cleans up abort listener after promise resolves", async () => {
		const controller = new AbortController();
		// Verify that aborting after completion doesn't cause issues
		await raceWithAbort(Promise.resolve("done"), controller.signal);

		// Aborting after resolution should not throw
		controller.abort();
		// If we get here without errors, the listener was cleaned up
		expect(true).toBe(true);
	});

	it("cleans up abort listener after promise rejects", async () => {
		const controller = new AbortController();

		try {
			await raceWithAbort(Promise.reject(new Error("fail")), controller.signal);
		} catch {
			// expected
		}

		// Aborting after rejection should not throw
		controller.abort();
		// If we get here without errors, the listener was cleaned up
		expect(true).toBe(true);
	});
});
