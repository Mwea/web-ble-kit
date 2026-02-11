import { describe, expect, it, vi } from "vitest";
import { createStateMachine } from "./state-machine";

describe("createStateMachine", () => {
	describe("initial state", () => {
		it("defaults to disconnected", () => {
			const sm = createStateMachine();
			expect(sm.getState()).toBe("disconnected");
		});

		it("accepts custom initial state", () => {
			const sm = createStateMachine("error");
			expect(sm.getState()).toBe("error");
		});
	});

	describe("valid transitions", () => {
		it("disconnected -> connecting", () => {
			const sm = createStateMachine("disconnected");
			expect(sm.canTransition("connecting")).toBe(true);
			sm.transition("connecting");
			expect(sm.getState()).toBe("connecting");
		});

		it("connecting -> connected", () => {
			const sm = createStateMachine("connecting");
			expect(sm.canTransition("connected")).toBe(true);
			sm.transition("connected");
			expect(sm.getState()).toBe("connected");
		});

		it("connecting -> error", () => {
			const sm = createStateMachine("connecting");
			expect(sm.canTransition("error")).toBe(true);
			sm.transition("error");
			expect(sm.getState()).toBe("error");
		});

		it("connecting -> disconnected (cancelled)", () => {
			const sm = createStateMachine("connecting");
			expect(sm.canTransition("disconnected")).toBe(true);
			sm.transition("disconnected");
			expect(sm.getState()).toBe("disconnected");
		});

		it("connected -> disconnected", () => {
			const sm = createStateMachine("connected");
			expect(sm.canTransition("disconnected")).toBe(true);
			sm.transition("disconnected");
			expect(sm.getState()).toBe("disconnected");
		});

		it("error -> disconnected", () => {
			const sm = createStateMachine("error");
			expect(sm.canTransition("disconnected")).toBe(true);
			sm.transition("disconnected");
			expect(sm.getState()).toBe("disconnected");
		});

		it("error -> connecting", () => {
			const sm = createStateMachine("error");
			expect(sm.canTransition("connecting")).toBe(true);
			sm.transition("connecting");
			expect(sm.getState()).toBe("connecting");
		});
	});

	describe("invalid transitions", () => {
		it("disconnected cannot go directly to connected", () => {
			const sm = createStateMachine("disconnected");
			expect(sm.canTransition("connected")).toBe(false);
		});

		it("disconnected cannot go directly to error", () => {
			const sm = createStateMachine("disconnected");
			expect(sm.canTransition("error")).toBe(false);
		});

		it("connected cannot go to connecting", () => {
			const sm = createStateMachine("connected");
			expect(sm.canTransition("connecting")).toBe(false);
		});

		// F-007 FIX: connected CAN now go to error (for command failures)
		it("connected can now go to error (F-007 fix)", () => {
			const sm = createStateMachine("connected");
			expect(sm.canTransition("error")).toBe(true);
			sm.transition("error");
			expect(sm.getState()).toBe("error");
		});

		it("throws on invalid transition", () => {
			const sm = createStateMachine("disconnected");
			expect(() => sm.transition("connected")).toThrow(
				"Invalid state transition: disconnected -> connected",
			);
			// State should not change
			expect(sm.getState()).toBe("disconnected");
		});
	});

	describe("transition callbacks", () => {
		it("calls callback on transition", () => {
			const sm = createStateMachine("disconnected");
			const callback = vi.fn();

			sm.onTransition(callback);
			sm.transition("connecting");

			expect(callback).toHaveBeenCalledWith("disconnected", "connecting");
		});

		it("calls multiple callbacks", () => {
			const sm = createStateMachine("disconnected");
			const callback1 = vi.fn();
			const callback2 = vi.fn();

			sm.onTransition(callback1);
			sm.onTransition(callback2);
			sm.transition("connecting");

			expect(callback1).toHaveBeenCalledWith("disconnected", "connecting");
			expect(callback2).toHaveBeenCalledWith("disconnected", "connecting");
		});

		it("returns unsubscribe function", () => {
			const sm = createStateMachine("disconnected");
			const callback = vi.fn();

			const unsubscribe = sm.onTransition(callback);
			sm.transition("connecting");
			expect(callback).toHaveBeenCalledTimes(1);

			unsubscribe();
			sm.transition("connected");
			expect(callback).toHaveBeenCalledTimes(1); // Still 1
		});

		it("swallows callback errors and continues to other callbacks", () => {
			const consoleErrorSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});

			const sm = createStateMachine("disconnected");
			const errorCallback = vi.fn(() => {
				throw new Error("Callback error");
			});
			const normalCallback = vi.fn();

			sm.onTransition(errorCallback);
			sm.onTransition(normalCallback);

			// Should not throw
			expect(() => sm.transition("connecting")).not.toThrow();

			// Both callbacks should have been called
			expect(errorCallback).toHaveBeenCalled();
			expect(normalCallback).toHaveBeenCalled();

			// State should have changed
			expect(sm.getState()).toBe("connecting");

			consoleErrorSpy.mockRestore();
		});

		it("logs callback errors via console.error", () => {
			const consoleErrorSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});

			const sm = createStateMachine("disconnected");
			const testError = new Error("Test callback error");
			sm.onTransition(() => {
				throw testError;
			});

			sm.transition("connecting");

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				"[web-ble-kit:state-machine] Transition callback error:",
				testError,
			);

			consoleErrorSpy.mockRestore();
		});
	});

	describe("full connection lifecycle", () => {
		it("supports complete connect -> disconnect cycle", () => {
			const sm = createStateMachine();
			const transitions: string[] = [];

			sm.onTransition((from, to) => {
				transitions.push(`${from}->${to}`);
			});

			sm.transition("connecting");
			sm.transition("connected");
			sm.transition("disconnected");

			expect(transitions).toEqual([
				"disconnected->connecting",
				"connecting->connected",
				"connected->disconnected",
			]);
		});

		it("supports error recovery cycle", () => {
			const sm = createStateMachine();

			sm.transition("connecting");
			sm.transition("error");
			sm.transition("connecting");
			sm.transition("connected");

			expect(sm.getState()).toBe("connected");
		});
	});
});
