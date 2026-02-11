/** Bluetooth Base UUID suffix for constructing full UUIDs */
export const BLUETOOTH_UUID_BASE = "-0000-1000-8000-00805f9b34fb";

/**
 * Converts a short UUID to a full Bluetooth Base UUID.
 * @param shortId - A number (0-65535) or hex string (1-4 chars)
 * @throws RangeError if number is out of 16-bit range
 * @throws Error if string is invalid hex or empty
 *
 * @example
 * ```typescript
 * // From number
 * toFullUuid(0xfe00); // "0000fe00-0000-1000-8000-00805f9b34fb"
 *
 * // From hex string
 * toFullUuid("fe00"); // "0000fe00-0000-1000-8000-00805f9b34fb"
 * toFullUuid("1");    // "00000001-0000-1000-8000-00805f9b34fb"
 * ```
 */
export function toFullUuid(shortId: number | string): string {
	if (typeof shortId === "number") {
		if (!Number.isInteger(shortId) || shortId < 0 || shortId > 0xffff) {
			throw new RangeError(
				`Short UUID must be integer 0-65535, got ${shortId}`,
			);
		}
		return `0000${shortId.toString(16).padStart(4, "0")}${BLUETOOTH_UUID_BASE}`;
	}

	if (shortId.length === 0 || shortId.length > 4) {
		throw new Error(
			`Invalid short UUID length: ${shortId.length} (must be 1-4)`,
		);
	}

	if (!/^[0-9a-fA-F]+$/.test(shortId)) {
		throw new Error(`Invalid short UUID format: ${shortId} (must be hex)`);
	}

	return `0000${shortId.toLowerCase().padStart(4, "0")}${BLUETOOTH_UUID_BASE}`;
}

/**
 * Checks if a UUID matches a short UUID identifier.
 * Handles short IDs of 1-4 hex characters and full 128-bit Bluetooth Base UUIDs.
 * Full UUID format: 0000XXXX-0000-1000-8000-00805f9b34fb where XXXX is the short ID (zero-padded).
 *
 * @example
 * ```typescript
 * uuidMatches('0000fe00-0000-1000-8000-00805f9b34fb', 'fe00') // true
 * uuidMatches('00000001-0000-1000-8000-00805f9b34fb', '1')    // true
 * uuidMatches('00000001-0000-1000-8000-00805f9b34fb', '01')   // true
 * ```
 */
export function uuidMatches(uuid: string, shortId: string): boolean {
	const normalized = uuid.toLowerCase();
	// Pad short ID to 4 characters for consistent comparison
	const shortNormalized = shortId.toLowerCase().padStart(4, "0");

	// Direct match for short UUIDs (also pad the uuid if it's short)
	const normalizedPadded =
		normalized.length <= 4 ? normalized.padStart(4, "0") : normalized;
	if (normalizedPadded === shortNormalized) {
		return true;
	}

	// For full UUIDs, the short ID appears at position 4-8 (after '0000')
	// Format: 0000XXXX-0000-1000-8000-00805f9b34fb
	if (normalized.length === 36 && normalized.charAt(8) === "-") {
		const extractedShortId = normalized.substring(4, 8);
		return extractedShortId === shortNormalized;
	}

	return false;
}
