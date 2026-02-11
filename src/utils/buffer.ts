/** Helper to safely read a byte with bounds checking */
function safeReadByte(data: Uint8Array, offset: number): number | undefined {
	if (offset < 0 || offset >= data.length) {
		return undefined;
	}
	return data[offset];
}

export function readByte(data: Uint8Array, offset: number): number {
	const value = safeReadByte(data, offset);
	return value ?? 0;
}

export function readUint16LE(data: Uint8Array, offset: number): number {
	if (offset < 0 || offset + 2 > data.length) {
		return 0;
	}
	return readByte(data, offset) | (readByte(data, offset + 1) << 8);
}

export function readUint24LE(data: Uint8Array, offset: number): number {
	if (offset < 0 || offset + 3 > data.length) {
		return 0;
	}
	return (
		readByte(data, offset) |
		(readByte(data, offset + 1) << 8) |
		(readByte(data, offset + 2) << 16)
	);
}

export function readUint24BE(data: Uint8Array, offset: number): number {
	if (offset < 0 || offset + 3 > data.length) {
		return 0;
	}
	return (
		(readByte(data, offset) << 16) |
		(readByte(data, offset + 1) << 8) |
		readByte(data, offset + 2)
	);
}

/**
 * Reads a single byte, returning undefined for invalid offsets.
 * Unlike readByte which returns 0, this allows distinguishing between
 * actual zero values and read errors.
 */
export function readByteChecked(
	data: Uint8Array,
	offset: number,
): number | undefined {
	return safeReadByte(data, offset);
}

/**
 * Reads a 16-bit little-endian value, returning undefined for invalid offsets.
 */
export function readUint16LEChecked(
	data: Uint8Array,
	offset: number,
): number | undefined {
	const b0 = safeReadByte(data, offset);
	const b1 = safeReadByte(data, offset + 1);
	if (b0 === undefined || b1 === undefined) {
		return undefined;
	}
	return b0 | (b1 << 8);
}

/**
 * Reads a 24-bit little-endian value, returning undefined for invalid offsets.
 */
export function readUint24LEChecked(
	data: Uint8Array,
	offset: number,
): number | undefined {
	const b0 = safeReadByte(data, offset);
	const b1 = safeReadByte(data, offset + 1);
	const b2 = safeReadByte(data, offset + 2);
	if (b0 === undefined || b1 === undefined || b2 === undefined) {
		return undefined;
	}
	return b0 | (b1 << 8) | (b2 << 16);
}

/**
 * Reads a 24-bit big-endian value, returning undefined for invalid offsets.
 */
export function readUint24BEChecked(
	data: Uint8Array,
	offset: number,
): number | undefined {
	const b0 = safeReadByte(data, offset);
	const b1 = safeReadByte(data, offset + 1);
	const b2 = safeReadByte(data, offset + 2);
	if (b0 === undefined || b1 === undefined || b2 === undefined) {
		return undefined;
	}
	return (b0 << 16) | (b1 << 8) | b2;
}

/**
 * Safely extracts an ArrayBuffer from a DataView.
 * Returns a copy to handle potential detached buffer issues.
 * If the buffer is detached or inaccessible, returns null.
 *
 * @example
 * ```typescript
 * const view = characteristic.value; // DataView from BLE notification
 * const buffer = extractArrayBuffer(view);
 * if (buffer) {
 *   const data = new Uint8Array(buffer);
 *   // Process data...
 * }
 * ```
 */
export function extractArrayBuffer(
	value: DataView | undefined,
): ArrayBuffer | null {
	if (!value) {
		return null;
	}

	try {
		// Access byteLength first - this will throw if buffer is detached
		const byteLength = value.byteLength;

		// Empty views are valid but useless for our purposes
		if (byteLength === 0) {
			return null;
		}

		// Verify buffer is accessible by checking its byteLength
		// A detached buffer will throw when accessing properties
		const bufferLength = value.buffer.byteLength;

		// Sanity check: view's byte range must fit within buffer
		if (value.byteOffset + byteLength > bufferLength) {
			// Invalid state - buffer may have been transferred
			return null;
		}

		// Create a copy of the relevant portion of the buffer
		// This handles DataViews with offset and avoids detached buffer issues
		const copy = new Uint8Array(byteLength);
		const source = new Uint8Array(value.buffer, value.byteOffset, byteLength);
		copy.set(source);
		return copy.buffer;
	} catch {
		// Buffer is detached or otherwise inaccessible
		// This catch handles TypeError thrown when accessing detached buffer properties
		return null;
	}
}
