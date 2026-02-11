import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BLEAdapter, BLEConnectedSession } from "../types";
import {
	type ConnectionPoolOptions,
	createConnectionPool,
	MAX_BLE_CONNECTIONS,
} from "./connection-pool";

// Mock session factory
function createMockSession(deviceId: string): BLEConnectedSession {
	const disconnectCallbacks: (() => void)[] = [];

	return {
		deviceId,
		deviceName: `Device ${deviceId}`,
		getPrimaryServices: vi.fn().mockResolvedValue([]),
		getPrimaryService: vi.fn().mockResolvedValue({}),
		disconnect: vi.fn().mockResolvedValue(undefined),
		onDisconnect: vi.fn((callback: () => void) => {
			disconnectCallbacks.push(callback);
			return () => {
				const idx = disconnectCallbacks.indexOf(callback);
				if (idx >= 0) disconnectCallbacks.splice(idx, 1);
			};
		}),
		// Helper to simulate disconnect (not part of interface)
		_triggerDisconnect: () => {
			disconnectCallbacks.forEach((cb) => {
				cb();
			});
		},
	} as BLEConnectedSession & { _triggerDisconnect: () => void };
}

// Mock adapter factory
function createMockAdapter(deviceId: string): BLEAdapter {
	const session = createMockSession(deviceId);
	return {
		connect: vi.fn().mockResolvedValue(session),
		reconnect: vi.fn().mockResolvedValue(session),
		forgetDevice: vi.fn(),
		getAvailability: vi.fn().mockResolvedValue(true),
	};
}

describe("createConnectionPool", () => {
	let deviceCounter: number;

	beforeEach(() => {
		deviceCounter = 0;
	});

	function createPool(options?: ConnectionPoolOptions) {
		return createConnectionPool({
			createAdapter: () => createMockAdapter(`device-${++deviceCounter}`),
			...options,
		});
	}

	describe("connect", () => {
		it("connects to a device and returns session", async () => {
			const pool = createPool();
			const session = await pool.connect();

			expect(session).toBeDefined();
			expect(session.deviceId).toBe("device-1");
		});

		it("tracks connected sessions", async () => {
			const pool = createPool();
			await pool.connect();

			expect(pool.connectionCount).toBe(1);
			expect(pool.isConnected("device-1")).toBe(true);
		});

		it("allows multiple connections", async () => {
			const pool = createPool();
			await pool.connect();
			await pool.connect();

			expect(pool.connectionCount).toBe(2);
			expect(pool.isConnected("device-1")).toBe(true);
			expect(pool.isConnected("device-2")).toBe(true);
		});

		it("throws when max connections reached", async () => {
			const pool = createPool({ maxConnections: 2 });
			await pool.connect();
			await pool.connect();

			await expect(pool.connect()).rejects.toThrow(/Maximum connections/);
		});

		it("emits connect event", async () => {
			const pool = createPool();
			const onConnect = vi.fn();
			pool.onConnect(onConnect);

			await pool.connect();

			expect(onConnect).toHaveBeenCalledWith("device-1", expect.any(Object));
		});
	});

	describe("getSession", () => {
		it("returns session for connected device", async () => {
			const pool = createPool();
			const session = await pool.connect();

			expect(pool.getSession("device-1")).toBe(session);
		});

		it("returns null for unknown device", () => {
			const pool = createPool();
			expect(pool.getSession("unknown")).toBeNull();
		});
	});

	describe("disconnect", () => {
		it("disconnects a specific device", async () => {
			const pool = createPool();
			const session = await pool.connect();

			await pool.disconnect("device-1");

			expect(session.disconnect).toHaveBeenCalled();
			expect(pool.connectionCount).toBe(0);
			expect(pool.isConnected("device-1")).toBe(false);
		});

		it("emits disconnect event", async () => {
			const pool = createPool();
			const onDisconnect = vi.fn();
			pool.onDisconnect(onDisconnect);

			await pool.connect();
			await pool.disconnect("device-1");

			expect(onDisconnect).toHaveBeenCalledWith("device-1");
		});

		it("does nothing for unknown device", async () => {
			const pool = createPool();
			await expect(pool.disconnect("unknown")).resolves.not.toThrow();
		});
	});

	describe("disconnectAll", () => {
		it("disconnects all devices", async () => {
			const pool = createPool();
			const session1 = await pool.connect();
			const session2 = await pool.connect();

			await pool.disconnectAll();

			expect(session1.disconnect).toHaveBeenCalled();
			expect(session2.disconnect).toHaveBeenCalled();
			expect(pool.connectionCount).toBe(0);
		});
	});

	describe("getSessions", () => {
		it("returns map of all sessions", async () => {
			const pool = createPool();
			await pool.connect();
			await pool.connect();

			const sessions = pool.getSessions();

			expect(sessions.size).toBe(2);
			expect(sessions.has("device-1")).toBe(true);
			expect(sessions.has("device-2")).toBe(true);
		});

		it("returns a copy (not internal map)", async () => {
			const pool = createPool();
			await pool.connect();

			const sessions = pool.getSessions();
			sessions.clear();

			expect(pool.connectionCount).toBe(1);
		});
	});

	describe("maxConnections", () => {
		it("uses default max connections", () => {
			const pool = createPool();
			expect(pool.maxConnections).toBe(MAX_BLE_CONNECTIONS);
		});

		it("respects custom max connections", () => {
			const pool = createPool({ maxConnections: 3 });
			expect(pool.maxConnections).toBe(3);
		});
	});

	describe("unexpected disconnect handling", () => {
		it("cleans up session on unexpected disconnect", async () => {
			const pool = createPool();
			const session = (await pool.connect()) as BLEConnectedSession & {
				_triggerDisconnect: () => void;
			};

			expect(pool.connectionCount).toBe(1);

			// Simulate unexpected disconnect
			session._triggerDisconnect();

			expect(pool.connectionCount).toBe(0);
			expect(pool.isConnected("device-1")).toBe(false);
		});

		it("emits disconnect event on unexpected disconnect", async () => {
			const pool = createPool();
			const onDisconnect = vi.fn();
			pool.onDisconnect(onDisconnect);

			const session = (await pool.connect()) as BLEConnectedSession & {
				_triggerDisconnect: () => void;
			};
			session._triggerDisconnect();

			expect(onDisconnect).toHaveBeenCalledWith("device-1");
		});
	});

	describe("event unsubscription", () => {
		it("onConnect returns unsubscribe function", async () => {
			const pool = createPool();
			const onConnect = vi.fn();
			const unsubscribe = pool.onConnect(onConnect);

			await pool.connect();
			expect(onConnect).toHaveBeenCalledTimes(1);

			unsubscribe();
			await pool.connect();
			expect(onConnect).toHaveBeenCalledTimes(1); // Still 1, not called again
		});

		it("onDisconnect returns unsubscribe function", async () => {
			const pool = createPool();
			const onDisconnect = vi.fn();
			const unsubscribe = pool.onDisconnect(onDisconnect);

			await pool.connect();
			await pool.disconnect("device-1");
			expect(onDisconnect).toHaveBeenCalledTimes(1);

			unsubscribe();
			await pool.connect();
			await pool.disconnect("device-2");
			expect(onDisconnect).toHaveBeenCalledTimes(1); // Still 1
		});
	});
});
