import { describe, expect, it } from "vitest";
import {
	readByte,
	readByteChecked,
	readUint16LE,
	readUint16LEChecked,
	readUint24BE,
	readUint24BEChecked,
	readUint24LE,
	readUint24LEChecked,
} from "./buffer";

describe("readByte", () => {
	it("reads byte at valid offset", () => {
		const data = new Uint8Array([0x12, 0x34, 0x56]);
		expect(readByte(data, 0)).toBe(0x12);
		expect(readByte(data, 1)).toBe(0x34);
		expect(readByte(data, 2)).toBe(0x56);
	});

	it("returns 0 for out of bounds offset", () => {
		const data = new Uint8Array([0x12, 0x34]);
		expect(readByte(data, 2)).toBe(0);
		expect(readByte(data, 100)).toBe(0);
	});

	it("returns 0 for negative offset", () => {
		const data = new Uint8Array([0x12, 0x34]);
		expect(readByte(data, -1)).toBe(0);
	});

	it("handles empty array", () => {
		const data = new Uint8Array([]);
		expect(readByte(data, 0)).toBe(0);
	});
});

describe("readUint16LE", () => {
	it("reads 16-bit little-endian value", () => {
		const data = new Uint8Array([0x34, 0x12]); // 0x1234 in little-endian
		expect(readUint16LE(data, 0)).toBe(0x1234);
	});

	it("reads at offset", () => {
		const data = new Uint8Array([0x00, 0x34, 0x12]);
		expect(readUint16LE(data, 1)).toBe(0x1234);
	});

	it("returns 0 when not enough bytes", () => {
		const data = new Uint8Array([0x12]);
		expect(readUint16LE(data, 0)).toBe(0);
	});

	it("returns 0 for out of bounds", () => {
		const data = new Uint8Array([0x12, 0x34]);
		expect(readUint16LE(data, 1)).toBe(0); // Only 1 byte available at offset 1
		expect(readUint16LE(data, 2)).toBe(0);
	});

	it("returns 0 for negative offset", () => {
		const data = new Uint8Array([0x12, 0x34]);
		expect(readUint16LE(data, -1)).toBe(0);
		expect(readUint16LE(data, -100)).toBe(0);
	});

	it("handles max value", () => {
		const data = new Uint8Array([0xff, 0xff]);
		expect(readUint16LE(data, 0)).toBe(0xffff);
	});
});

describe("readUint24LE", () => {
	it("reads 24-bit little-endian value", () => {
		const data = new Uint8Array([0x56, 0x34, 0x12]); // 0x123456 in little-endian
		expect(readUint24LE(data, 0)).toBe(0x123456);
	});

	it("reads at offset", () => {
		const data = new Uint8Array([0x00, 0x56, 0x34, 0x12]);
		expect(readUint24LE(data, 1)).toBe(0x123456);
	});

	it("returns 0 when not enough bytes", () => {
		const data = new Uint8Array([0x12, 0x34]);
		expect(readUint24LE(data, 0)).toBe(0);
	});

	it("returns 0 for out of bounds", () => {
		const data = new Uint8Array([0x12, 0x34, 0x56]);
		expect(readUint24LE(data, 1)).toBe(0); // Only 2 bytes available at offset 1
		expect(readUint24LE(data, 3)).toBe(0);
	});

	it("returns 0 for negative offset", () => {
		const data = new Uint8Array([0x12, 0x34, 0x56]);
		expect(readUint24LE(data, -1)).toBe(0);
		expect(readUint24LE(data, -100)).toBe(0);
	});

	it("handles max value", () => {
		const data = new Uint8Array([0xff, 0xff, 0xff]);
		expect(readUint24LE(data, 0)).toBe(0xffffff);
	});
});

describe("readUint24BE", () => {
	it("reads 24-bit big-endian value", () => {
		const data = new Uint8Array([0x12, 0x34, 0x56]); // 0x123456 in big-endian
		expect(readUint24BE(data, 0)).toBe(0x123456);
	});

	it("reads at offset", () => {
		const data = new Uint8Array([0x00, 0x12, 0x34, 0x56]);
		expect(readUint24BE(data, 1)).toBe(0x123456);
	});

	it("returns 0 when not enough bytes", () => {
		const data = new Uint8Array([0x12, 0x34]);
		expect(readUint24BE(data, 0)).toBe(0);
	});

	it("returns 0 for out of bounds", () => {
		const data = new Uint8Array([0x12, 0x34, 0x56]);
		expect(readUint24BE(data, 1)).toBe(0); // Only 2 bytes available at offset 1
		expect(readUint24BE(data, 3)).toBe(0);
	});

	it("returns 0 for negative offset", () => {
		const data = new Uint8Array([0x12, 0x34, 0x56]);
		expect(readUint24BE(data, -1)).toBe(0);
		expect(readUint24BE(data, -100)).toBe(0);
	});

	it("handles max value", () => {
		const data = new Uint8Array([0xff, 0xff, 0xff]);
		expect(readUint24BE(data, 0)).toBe(0xffffff);
	});

	it("differs from LE for same bytes", () => {
		const data = new Uint8Array([0x12, 0x34, 0x56]);
		expect(readUint24BE(data, 0)).toBe(0x123456);
		expect(readUint24LE(data, 0)).toBe(0x563412);
	});
});

// =============================================================================
// Checked variants - return undefined for invalid offsets
// =============================================================================

describe("readByteChecked", () => {
	it("returns value for valid offset", () => {
		const data = new Uint8Array([0x12, 0x34, 0x56]);
		expect(readByteChecked(data, 0)).toBe(0x12);
		expect(readByteChecked(data, 1)).toBe(0x34);
		expect(readByteChecked(data, 2)).toBe(0x56);
	});

	it("returns undefined for out of bounds offset", () => {
		const data = new Uint8Array([0x12, 0x34]);
		expect(readByteChecked(data, 2)).toBeUndefined();
		expect(readByteChecked(data, 100)).toBeUndefined();
	});

	it("returns undefined for negative offset", () => {
		const data = new Uint8Array([0x12, 0x34]);
		expect(readByteChecked(data, -1)).toBeUndefined();
	});

	it("handles empty array", () => {
		const data = new Uint8Array([]);
		expect(readByteChecked(data, 0)).toBeUndefined();
	});

	it("distinguishes 0 value from invalid offset", () => {
		const data = new Uint8Array([0x00, 0x01]);
		expect(readByteChecked(data, 0)).toBe(0); // Actual zero
		expect(readByteChecked(data, 10)).toBeUndefined(); // Invalid
	});
});

describe("readUint16LEChecked", () => {
	it("returns value for valid offset", () => {
		const data = new Uint8Array([0x34, 0x12]);
		expect(readUint16LEChecked(data, 0)).toBe(0x1234);
	});

	it("reads at offset", () => {
		const data = new Uint8Array([0x00, 0x34, 0x12]);
		expect(readUint16LEChecked(data, 1)).toBe(0x1234);
	});

	it("returns undefined when not enough bytes", () => {
		const data = new Uint8Array([0x12]);
		expect(readUint16LEChecked(data, 0)).toBeUndefined();
	});

	it("returns undefined for out of bounds", () => {
		const data = new Uint8Array([0x12, 0x34]);
		expect(readUint16LEChecked(data, 1)).toBeUndefined(); // Only 1 byte left
		expect(readUint16LEChecked(data, 2)).toBeUndefined();
	});

	it("returns undefined for negative offset", () => {
		const data = new Uint8Array([0x12, 0x34]);
		expect(readUint16LEChecked(data, -1)).toBeUndefined();
	});

	it("distinguishes 0 value from invalid offset", () => {
		const data = new Uint8Array([0x00, 0x00, 0x01]);
		expect(readUint16LEChecked(data, 0)).toBe(0); // Actual zero
		expect(readUint16LEChecked(data, 10)).toBeUndefined(); // Invalid
	});
});

describe("readUint24LEChecked", () => {
	it("returns value for valid offset", () => {
		const data = new Uint8Array([0x56, 0x34, 0x12]);
		expect(readUint24LEChecked(data, 0)).toBe(0x123456);
	});

	it("reads at offset", () => {
		const data = new Uint8Array([0x00, 0x56, 0x34, 0x12]);
		expect(readUint24LEChecked(data, 1)).toBe(0x123456);
	});

	it("returns undefined when not enough bytes", () => {
		const data = new Uint8Array([0x12, 0x34]);
		expect(readUint24LEChecked(data, 0)).toBeUndefined();
	});

	it("returns undefined for out of bounds", () => {
		const data = new Uint8Array([0x12, 0x34, 0x56]);
		expect(readUint24LEChecked(data, 1)).toBeUndefined(); // Only 2 bytes left
		expect(readUint24LEChecked(data, 3)).toBeUndefined();
	});

	it("returns undefined for negative offset", () => {
		const data = new Uint8Array([0x12, 0x34, 0x56]);
		expect(readUint24LEChecked(data, -1)).toBeUndefined();
	});
});

describe("readUint24BEChecked", () => {
	it("returns value for valid offset", () => {
		const data = new Uint8Array([0x12, 0x34, 0x56]);
		expect(readUint24BEChecked(data, 0)).toBe(0x123456);
	});

	it("reads at offset", () => {
		const data = new Uint8Array([0x00, 0x12, 0x34, 0x56]);
		expect(readUint24BEChecked(data, 1)).toBe(0x123456);
	});

	it("returns undefined when not enough bytes", () => {
		const data = new Uint8Array([0x12, 0x34]);
		expect(readUint24BEChecked(data, 0)).toBeUndefined();
	});

	it("returns undefined for out of bounds", () => {
		const data = new Uint8Array([0x12, 0x34, 0x56]);
		expect(readUint24BEChecked(data, 1)).toBeUndefined(); // Only 2 bytes left
		expect(readUint24BEChecked(data, 3)).toBeUndefined();
	});

	it("returns undefined for negative offset", () => {
		const data = new Uint8Array([0x12, 0x34, 0x56]);
		expect(readUint24BEChecked(data, -1)).toBeUndefined();
	});

	it("differs from LE for same bytes", () => {
		const data = new Uint8Array([0x12, 0x34, 0x56]);
		expect(readUint24BEChecked(data, 0)).toBe(0x123456);
		expect(readUint24LEChecked(data, 0)).toBe(0x563412);
	});
});
