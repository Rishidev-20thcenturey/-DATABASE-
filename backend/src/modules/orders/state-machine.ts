import type { OrderStatus, Role } from '../../types/domain.js';

/**
 * The only place where order status may change. Every transition names the roles allowed to make it.
 * Terminal states: REJECTED, CANCELLED, DELIVERED.
 *
 *   PENDING_RESTAURANT_CONFIRMATION -> CONFIRMED | REJECTED (restaurant) | CANCELLED (customer, admin)
 *   CONFIRMED                       -> PREPARING (restaurant) | CANCELLED (admin)
 *   PREPARING                       -> READY_FOR_PICKUP (restaurant)
 *   READY_FOR_PICKUP                -> PICKED_UP (courier, admin)
 *   PICKED_UP                       -> OUT_FOR_DELIVERY (courier, admin)
 *   OUT_FOR_DELIVERY                -> DELIVERED (courier, admin)
 */
export const TRANSITIONS: Partial<Record<OrderStatus, Partial<Record<OrderStatus, Role[]>>>> = {
  PENDING_RESTAURANT_CONFIRMATION: {
    CONFIRMED: ['RESTAURANT_OWNER'],
    REJECTED: ['RESTAURANT_OWNER'],
    CANCELLED: ['CUSTOMER', 'ADMIN'],
  },
  CONFIRMED: {
    PREPARING: ['RESTAURANT_OWNER'],
    CANCELLED: ['ADMIN'],
  },
  PREPARING: {
    READY_FOR_PICKUP: ['RESTAURANT_OWNER'],
  },
  READY_FOR_PICKUP: {
    PICKED_UP: ['COURIER', 'ADMIN'],
  },
  PICKED_UP: {
    OUT_FOR_DELIVERY: ['COURIER', 'ADMIN'],
  },
  OUT_FOR_DELIVERY: {
    DELIVERED: ['COURIER', 'ADMIN'],
  },
};

export type TransitionResult =
  | { ok: true }
  | { ok: false; code: 'INVALID_STATUS_TRANSITION' | 'ROLE_NOT_PERMITTED'; message: string };

export function checkTransition(from: OrderStatus, to: OrderStatus, actorRole: Role): TransitionResult {
  const allowed = TRANSITIONS[from]?.[to];
  if (!allowed) {
    return { ok: false, code: 'INVALID_STATUS_TRANSITION', message: `An order cannot move from ${from} to ${to}.` };
  }
  if (!allowed.includes(actorRole)) {
    return { ok: false, code: 'ROLE_NOT_PERMITTED', message: `Your role cannot move an order from ${from} to ${to}.` };
  }
  return { ok: true };
}

export const isTerminal = (status: OrderStatus) => !TRANSITIONS[status];
