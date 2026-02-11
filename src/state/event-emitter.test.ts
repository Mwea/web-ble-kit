import { describe, expect, it, vi } from "vitest";
import { createEventEmitter, toEventTarget } from "./event-emitter";

interface TestEvents extends Record<string, unknown> {
	message: string;
	count: number;
	data: { id: number; name: string };
}

describe("createEventEmitter", () => {
	describe("on/emit", () => {
		it("emits events to subscribers", () => {
			const emitter = createEventEmitter<TestEvents>();
			const callback = vi.fn();

			emitter.on("message", callback);
			emitter.emit("message", "hello");

			expect(callback).toHaveBeenCalledWith("hello");
		});

		it("supports multiple subscribers", () => {
			const emitter = createEventEmitter<TestEvents>();
			const callback1 = vi.fn();
			const callback2 = vi.fn();

			emitter.on("message", callback1);
			emitter.on("message", callback2);
			emitter.emit("message", "hello");

			expect(callback1).toHaveBeenCalledWith("hello");
			expect(callback2).toHaveBeenCalledWith("hello");
		});

		it("supports different event types", () => {
			const emitter = createEventEmitter<TestEvents>();
			const messageCallback = vi.fn();
			const countCallback = vi.fn();

			emitter.on("message", messageCallback);
			emitter.on("count", countCallback);

			emitter.emit("message", "hello");
			emitter.emit("count", 42);

			expect(messageCallback).toHaveBeenCalledWith("hello");
			expect(countCallback).toHaveBeenCalledWith(42);
		});

		it("returns unsubscribe function", () => {
			const emitter = createEventEmitter<TestEvents>();
			const callback = vi.fn();

			const unsubscribe = emitter.on("message", callback);
			emitter.emit("message", "first");
			expect(callback).toHaveBeenCalledTimes(1);

			unsubscribe();
			emitter.emit("message", "second");
			expect(callback).toHaveBeenCalledTimes(1);
		});

		it("handles complex data types", () => {
			const emitter = createEventEmitter<TestEvents>();
			const callback = vi.fn();

			emitter.on("data", callback);
			emitter.emit("data", { id: 1, name: "test" });

			expect(callback).toHaveBeenCalledWith({ id: 1, name: "test" });
		});
	});

	describe("once", () => {
		it("fires callback only once", () => {
			const emitter = createEventEmitter<TestEvents>();
			const callback = vi.fn();

			emitter.once("message", callback);
			emitter.emit("message", "first");
			emitter.emit("message", "second");

			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith("first");
		});

		it("returns unsubscribe function", () => {
			const emitter = createEventEmitter<TestEvents>();
			const callback = vi.fn();

			const unsubscribe = emitter.once("message", callback);
			unsubscribe();
			emitter.emit("message", "hello");

			expect(callback).not.toHaveBeenCalled();
		});
	});

	describe("off", () => {
		it("removes specific callback", () => {
			const emitter = createEventEmitter<TestEvents>();
			const callback1 = vi.fn();
			const callback2 = vi.fn();

			emitter.on("message", callback1);
			emitter.on("message", callback2);
			emitter.off("message", callback1);
			emitter.emit("message", "hello");

			expect(callback1).not.toHaveBeenCalled();
			expect(callback2).toHaveBeenCalledWith("hello");
		});

		it("handles removing non-existent callback", () => {
			const emitter = createEventEmitter<TestEvents>();
			const callback = vi.fn();

			// Should not throw
			expect(() => emitter.off("message", callback)).not.toThrow();
		});
	});

	describe("removeAllListeners", () => {
		it("removes all listeners for specific event", () => {
			const emitter = createEventEmitter<TestEvents>();
			const messageCallback1 = vi.fn();
			const messageCallback2 = vi.fn();
			const countCallback = vi.fn();

			emitter.on("message", messageCallback1);
			emitter.on("message", messageCallback2);
			emitter.on("count", countCallback);

			emitter.removeAllListeners("message");
			emitter.emit("message", "hello");
			emitter.emit("count", 42);

			expect(messageCallback1).not.toHaveBeenCalled();
			expect(messageCallback2).not.toHaveBeenCalled();
			expect(countCallback).toHaveBeenCalledWith(42);
		});

		it("removes all listeners when no event specified", () => {
			const emitter = createEventEmitter<TestEvents>();
			const messageCallback = vi.fn();
			const countCallback = vi.fn();

			emitter.on("message", messageCallback);
			emitter.on("count", countCallback);

			emitter.removeAllListeners();
			emitter.emit("message", "hello");
			emitter.emit("count", 42);

			expect(messageCallback).not.toHaveBeenCalled();
			expect(countCallback).not.toHaveBeenCalled();
		});
	});

	describe("listenerCount", () => {
		it("returns 0 for no listeners", () => {
			const emitter = createEventEmitter<TestEvents>();
			expect(emitter.listenerCount("message")).toBe(0);
		});

		it("returns correct count", () => {
			const emitter = createEventEmitter<TestEvents>();

			emitter.on("message", () => {});
			expect(emitter.listenerCount("message")).toBe(1);

			emitter.on("message", () => {});
			expect(emitter.listenerCount("message")).toBe(2);
		});

		it("updates after removal", () => {
			const emitter = createEventEmitter<TestEvents>();
			const callback = vi.fn();

			emitter.on("message", callback);
			expect(emitter.listenerCount("message")).toBe(1);

			emitter.off("message", callback);
			expect(emitter.listenerCount("message")).toBe(0);
		});
	});

	describe("error handling", () => {
		it("swallows callback errors and continues", async () => {
			const consoleErrorSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			const emitter = createEventEmitter<TestEvents>();
			const errorCallback = vi.fn(() => {
				throw new Error("Callback error");
			});
			const normalCallback = vi.fn();

			emitter.on("message", errorCallback);
			emitter.on("message", normalCallback);

			// Should not throw
			expect(() => emitter.emit("message", "hello")).not.toThrow();

			expect(errorCallback).toHaveBeenCalled();
			expect(normalCallback).toHaveBeenCalled();

			// Wait for queueMicrotask error logs to complete
			await new Promise((r) => setTimeout(r, 0));
			consoleErrorSpy.mockRestore();
		});

		it("logs errors to console.error", async () => {
			const consoleErrorSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			const emitter = createEventEmitter<TestEvents>();
			const errorCallback = vi.fn(() => {
				throw new Error("Test error");
			});

			emitter.on("message", errorCallback);
			emitter.emit("message", "hello");

			// Wait for microtask to complete
			await new Promise<void>((resolve) => queueMicrotask(resolve));

			expect(consoleErrorSpy).toHaveBeenCalled();
			expect(consoleErrorSpy.mock.calls[0]?.[0]).toContain("Listener threw");
			consoleErrorSpy.mockRestore();
		});
	});

	describe("no-op for unsubscribed events", () => {
		it("emit does nothing for events with no listeners", () => {
			const emitter = createEventEmitter<TestEvents>();

			// Should not throw
			expect(() => emitter.emit("message", "hello")).not.toThrow();
		});
	});
});

describe("toEventTarget", () => {
	it("creates an EventTarget from emitter", () => {
		const emitter = createEventEmitter<TestEvents>();
		const target = toEventTarget(emitter);

		expect(target).toBeInstanceOf(EventTarget);
	});

	it("forwards events as CustomEvents", () => {
		const emitter = createEventEmitter<TestEvents>();
		const target = toEventTarget(emitter);
		const callback = vi.fn();

		target.addEventListener("message", callback);
		emitter.emit("message", "hello");

		expect(callback).toHaveBeenCalled();
		const event = callback.mock.calls[0]?.[0] as CustomEvent;
		expect(event.detail).toBe("hello");
	});

	it("supports removeEventListener", () => {
		const emitter = createEventEmitter<TestEvents>();
		const target = toEventTarget(emitter);
		const callback = vi.fn();

		target.addEventListener("message", callback);
		target.removeEventListener("message", callback);
		emitter.emit("message", "hello");

		// Callback should NOT be called after removeEventListener
		expect(callback).not.toHaveBeenCalled();
	});

	it("handles complex data in CustomEvent detail", () => {
		const emitter = createEventEmitter<TestEvents>();
		const target = toEventTarget(emitter);
		const callback = vi.fn();

		target.addEventListener("data", callback);
		emitter.emit("data", { id: 42, name: "test" });

		const event = callback.mock.calls[0]?.[0] as CustomEvent;
		expect(event.detail).toEqual({ id: 42, name: "test" });
	});

	describe("cleanup", () => {
		it("unsubscribes from emitter when last listener removed", () => {
			const emitter = createEventEmitter<TestEvents>();
			const target = toEventTarget(emitter);
			const callback = vi.fn();

			target.addEventListener("message", callback);
			expect(emitter.listenerCount("message")).toBe(1);

			target.removeEventListener("message", callback);
			expect(emitter.listenerCount("message")).toBe(0);
		});

		it("tracks listener count per event type", () => {
			const emitter = createEventEmitter<TestEvents>();
			const target = toEventTarget(emitter);
			const callback1 = vi.fn();
			const callback2 = vi.fn();

			target.addEventListener("message", callback1);
			target.addEventListener("message", callback2);
			expect(emitter.listenerCount("message")).toBe(1); // Only one subscription to emitter

			// Both listeners should receive events
			emitter.emit("message", "test");
			expect(callback1).toHaveBeenCalledTimes(1);
			expect(callback2).toHaveBeenCalledTimes(1);

			target.removeEventListener("message", callback1);
			expect(emitter.listenerCount("message")).toBe(1); // Still subscribed

			target.removeEventListener("message", callback2);
			expect(emitter.listenerCount("message")).toBe(0); // Now unsubscribed
		});

		it("handles null listener gracefully", () => {
			const emitter = createEventEmitter<TestEvents>();
			const target = toEventTarget(emitter);

			// Should not throw or create subscriptions
			target.addEventListener("message", null);
			expect(emitter.listenerCount("message")).toBe(0);

			target.removeEventListener("message", null);
			expect(emitter.listenerCount("message")).toBe(0);
		});
	});

	describe("dispose", () => {
		it("returns CleanableEventTarget with dispose method", () => {
			const emitter = createEventEmitter<TestEvents>();
			const target = toEventTarget(emitter);

			expect(typeof target.dispose).toBe("function");
		});

		it("unsubscribes from emitter when disposed", () => {
			const emitter = createEventEmitter<TestEvents>();
			const target = toEventTarget(emitter);
			const callback = vi.fn();

			target.addEventListener("message", callback);
			expect(emitter.listenerCount("message")).toBe(1);

			target.dispose();
			expect(emitter.listenerCount("message")).toBe(0);
		});

		it("clears all internal state when disposed", () => {
			const emitter = createEventEmitter<TestEvents>();
			const target = toEventTarget(emitter);
			const callback1 = vi.fn();
			const callback2 = vi.fn();

			target.addEventListener("message", callback1);
			target.addEventListener("count", callback2);

			expect(emitter.listenerCount("message")).toBe(1);
			expect(emitter.listenerCount("count")).toBe(1);

			target.dispose();

			expect(emitter.listenerCount("message")).toBe(0);
			expect(emitter.listenerCount("count")).toBe(0);
		});

		it("events no longer fire after dispose", () => {
			const emitter = createEventEmitter<TestEvents>();
			const target = toEventTarget(emitter);
			const callback = vi.fn();

			target.addEventListener("message", callback);
			target.dispose();

			// Emit after dispose - callback should not be called
			emitter.emit("message", "hello");
			expect(callback).not.toHaveBeenCalled();
		});

		it("dispose is idempotent - can be called multiple times", () => {
			const emitter = createEventEmitter<TestEvents>();
			const target = toEventTarget(emitter);
			const callback = vi.fn() as unknown as EventListener;

			target.addEventListener("message", callback);

			// Should not throw when called multiple times
			expect(() => {
				target.dispose();
				target.dispose();
				target.dispose();
			}).not.toThrow();
		});
	});
});
