import { query, type Queryable } from '../db/pool.js';

/** Records a sensitive administrative change. Never pass secrets or password hashes in `details`. */
export async function audit(
  actorId: string,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown>,
  db?: Queryable,
): Promise<void> {
  await query(
    'INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5)',
    [actorId, action, entityType, entityId, JSON.stringify(details)],
    db,
  );
}
