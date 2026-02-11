import { describe, expect, it } from "vitest";
import { AbortError } from "../errors";
import { createOperationQueue } from "./operation-queue";

describe("createOperationQueue", () => {
	describe("basic functionality", () => {
		it("executes a single operation", async () => {
			const queue = createOperationQueue();
			const result = await queue.enqueue("char-1", () =>
				Promise.resolve("success"),
			);
			expect(result).toBe("success");
		});

		it("returns the operation result", async () => {
			const queue = createOperationQueue();
			const result = await queue.enqueue("char-1", async () => {
				return { data: 42 };
			});
			expect(result).toEqual({ data: 42 });
		});

		it("propagates operation errors", async () => {
			const queue = createOperationQueue();
			await expect(
				queue.enqueue("char-1", () =>
					Promise.reject(new Error("Operation failed")),
				),
			).rejects.toThrow("Operation failed");
		});
	});

	describe("serialization", () => {
		it("serializes operations on the same characteristic", async () => {
			const queue = createOperationQueue();
			const order: number[] = [];

			const op1 = queue.enqueue("char-1", async () => {
				await new Promise((r) => setTimeout(r, 50));
				order.push(1);
				return 1;
			});

			const op2 = queue.enqueue("char-1", async () => {
				order.push(2);
				return 2;
			});

			await Promise.all([op1, op2]);

			// op1 should complete before op2 starts
			expect(order).toEqual([1, 2]);
		});

		it("allows parallel operations on different characteristics", async () => {
			const queue = createOperationQueue();
			const order: string[] = [];

			const op1 = queue.enqueue("char-1", async () => {
				await new Promise((r) => setTimeout(r, 50));
				order.push("char-1-done");
				return 1;
			});

			const op2 = queue.enqueue("char-2", async () => {
				order.push("char-2-done");
				return 2;
			});

			await Promise.all([op1, op2]);

			// char-2 should complete first (no delay)
			expect(order).toEqual(["char-2-done", "char-1-done"]);
		});

		it("maintains separate queues per characteristic", async () => {
			const queue = createOperationQueue();
			const results: string[] = [];

			// Queue multiple operations on two different characteristics
			const promises = [
				await queue.enqueue("char-1", async () => {
					await new Promise((r) => setTimeout(r, 30));
					results.push("1-a");
				}),
				await queue.enqueue("char-1", async () => {
					results.push("1-b");
				}),
				await queue.enqueue("char-2", async () => {
					await new Promise((r) => setTimeout(r, 10));
					results.push("2-a");
				}),
				await queue.enqueue("char-2", async () => {
					results.push("2-b");
				}),
			];

			await Promise.all(promises);

			// Each characteristic's operations should be in order
			const char1Order = results.filter((r) => r.startsWith("1-"));
			const char2Order = results.filter((r) => r.startsWith("2-"));

			expect(char1Order).toEqual(["1-a", "1-b"]);
			expect(char2Order).toEqual(["2-a", "2-b"]);
		});
	});

	describe("getQueueDepth", () => {
		it("returns 0 for unknown characteristic", () => {
			const queue = createOperationQueue();
			expect(queue.getQueueDepth("unknown")).toBe(0);
		});

		it("tracks pending operations", async () => {
			const queue = createOperationQueue();
			let resolveOp: (() => void) | undefined;

			// Create a promise that we control
			const op1Promise = new Promise<void>((resolve) => {
				resolveOp = resolve;
			});

			const op1 = queue.enqueue("char-1", () => op1Promise);

			// Give the queue time to start processing
			await Promise.resolve();

			// op1 is pending - depth should be at least 1
			expect(queue.getQueueDepth("char-1")).toBeGreaterThanOrEqual(1);

			// Add more operations
			const op2 = queue.enqueue("char-1", () => Promise.resolve());
			expect(queue.getQueueDepth("char-1")).toBeGreaterThanOrEqual(2);

			const op3 = queue.enqueue("char-1", () => Promise.resolve());
			expect(queue.getQueueDepth("char-1")).toBeGreaterThanOrEqual(3);

			// Complete all operations
			resolveOp?.();
			await Promise.all([op1, op2, op3]);

			// After completion, depth should be 0 or close to it
			// (there may be slight async timing differences)
			await new Promise((r) => setTimeout(r, 10));
			expect(queue.getQueueDepth("char-1")).toBe(0);
		});
	});

	describe("abort signal", () => {
		it("rejects immediately if signal is already aborted", async () => {
			const controller = new AbortController();
			controller.abort();

			const queue = createOperationQueue({ signal: controller.signal });

			await expect(
				queue.enqueue("char-1", () => Promise.resolve("success")),
			).rejects.toThrow(AbortError);
		});

		it("rejects pending operations when aborted", async () => {
			const controller = new AbortController();
			const queue = createOperationQueue({ signal: controller.signal });
			let resolveOp: (() => void) | undefined;

			// Create a promise that we control
			const op1Promise = new Promise<void>((resolve) => {
				resolveOp = resolve;
			});

			const op1 = queue.enqueue("char-1", () => op1Promise);

			// Give the queue time to start processing op1
			await Promise.resolve();

			const op2 = queue.enqueue("char-1", () => Promise.resolve("success"));

			// Abort while op1 is running - op2 is still queued
			controller.abort();

			// Both should reject with AbortError due to the signal
			await expect(op2).rejects.toThrow(AbortError);

			// Complete op1 - it will complete normally since it was already running
			resolveOp?.();
			// op1 may have already been rejected due to the abort handler
			await op1.catch(() => {});
		});

		it("preserves abort reason message", async () => {
			const controller = new AbortController();
			controller.abort(new Error("Custom abort reason"));

			const queue = createOperationQueue({ signal: controller.signal });

			await expect(
				queue.enqueue("char-1", () => Promise.resolve()),
			).rejects.toThrow("Custom abort reason");
		});
	});

	describe("clear", () => {
		it("rejects new operations after clear", async () => {
			const queue = createOperationQueue();

			queue.clear();

			await expect(
				queue.enqueue("char-1", () => Promise.resolve("success")),
			).rejects.toThrow(AbortError);
		});

		it("resets queue depth", async () => {
			const queue = createOperationQueue();
			let resolveOp: (() => void) | undefined;

			const op = queue
				.enqueue(
					"char-1",
					() =>
						new Promise<void>((resolve) => {
							resolveOp = resolve;
						}),
				)
				.catch(() => {
					// Ignore AbortError from clear()
				});

			// Give the queue time to start processing
			await Promise.resolve();

			expect(queue.getQueueDepth("char-1")).toBeGreaterThanOrEqual(1);

			queue.clear();

			expect(queue.getQueueDepth("char-1")).toBe(0);

			// Resolve the pending operation
			resolveOp?.();
			await op;
		});
	});

	describe("error handling", () => {
		it("continues queue after operation failure", async () => {
			const queue = createOperationQueue();
			const results: string[] = [];

			const op1 = queue
				.enqueue("char-1", async () => {
					throw new Error("op1 failed");
				})
				.catch(() => {
					results.push("op1-failed");
				});

			const op2 = queue.enqueue("char-1", async () => {
				results.push("op2-success");
				return "success";
			});

			await Promise.all([op1, op2]);

			// Both operations should complete
			expect(results).toContain("op1-failed");
			expect(results).toContain("op2-success");
		});

		it("does not leak promises after errors", async () => {
			const queue = createOperationQueue();

			// Run several failing operations
			await Promise.all([
				queue
					.enqueue("char-1", () => Promise.reject(new Error("fail 1")))
					.catch(() => {}),
				queue
					.enqueue("char-1", () => Promise.reject(new Error("fail 2")))
					.catch(() => {}),
				queue
					.enqueue("char-1", () => Promise.reject(new Error("fail 3")))
					.catch(() => {}),
			]);

			// Queue should be empty
			expect(queue.getQueueDepth("char-1")).toBe(0);
		});
	});
});
