export const ROLES = ['CUSTOMER', 'RESTAURANT_OWNER', 'COURIER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export const ORDER_STATUSES = [
  'PENDING_RESTAURANT_CONFIRMATION',
  'REJECTED',
  'CANCELLED',
  'CONFIRMED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface AuthUser {
  id: string;
  role: Role;
}
