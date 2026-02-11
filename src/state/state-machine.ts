import type { ConnectionState } from "../types";

export type TransitionCallback = (
	from: ConnectionState,
	to: ConnectionState,
) => void;

export interface StateMachine {
	getState(): ConnectionState;
	canTransition(to: ConnectionState): boolean;
	transition(to: ConnectionState): void;
	onTransition(callback: TransitionCallback): () => void;
}

/**
 * Valid state transitions:
 * - disconnected -> connecting
 * - connecting -> connected | error | disconnected (cancelled)
 * - connected -> disconnected | error
 * - error -> disconnected | connecting
 */
const VALID_TRANSITIONS: Record<ConnectionState, ConnectionState[]> = {
	disconnected: ["connecting"],
	connecting: ["connected", "error", "disconnected"],
	connected: ["disconnected", "error"],
	error: ["disconnected", "connecting"],
};

/**
 * Creates a new state machine for BLE connection management.
 * Enforces valid state transitions and notifies listeners on changes.
 *
 * @param initialState The initial state (default: 'disconnected')
 *
 * @example Basic connection flow
 * ```typescript
 * const machine = createStateMachine();
 *
 * // Listen for state changes
 * machine.onTransition((from, to) => {
 *   console.log(`State changed: ${from} -> ${to}`);
 *   updateUI(to);
 * });
 *
 * // Connect flow
 * machine.transition('connecting');
 * try {
 *   const session = await adapter.connect();
 *   machine.transition('connected');
 * } catch (error) {
 *   machine.transition('error');
 * }
 * ```
 *
 * @example Check before transitioning
 * ```typescript
 * if (machine.canTransition('connecting')) {
 *   machine.transition('connecting');
 * } else {
 *   console.log('Cannot connect from state:', machine.getState());
 * }
 * ```
 *
 * @example Handling disconnection
 * ```typescript
 * session.onDisconnect(() => {
 *   if (machine.getState() === 'connected') {
 *     machine.transition('disconnected');
 *   }
 * });
 * ```
 */
export function createStateMachine(
	initialState: ConnectionState = "disconnected",
): StateMachine {
	let state: ConnectionState = initialState;
	const callbacks = new Set<TransitionCallback>();
	let isTransitioning = false;

	function getState(): ConnectionState {
		return state;
	}

	function canTransition(to: ConnectionState): boolean {
		const validTargets = VALID_TRANSITIONS[state];
		return validTargets.includes(to);
	}

	function transition(to: ConnectionState): void {
		if (isTransitioning) {
			throw new Error(
				`Cannot transition while another transition is in progress (attempted ${state} -> ${to})`,
			);
		}

		if (!canTransition(to)) {
			throw new Error(`Invalid state transition: ${state} -> ${to}`);
		}

		const from = state;
		state = to;
		isTransitioning = true;

		try {
			for (const cb of callbacks) {
				try {
					cb(from, to);
				} catch (e) {
					console.error(
						"[web-ble-kit:state-machine] Transition callback error:",
						e,
					);
				}
			}
		} finally {
			isTransitioning = false;
		}
	}

	function onTransition(callback: TransitionCallback): () => void {
		callbacks.add(callback);
		return () => {
			callbacks.delete(callback);
		};
	}

	return {
		getState,
		canTransition,
		transition,
		onTransition,
	};
}
