// CE implementation (whitelabel fork)
import type { Knex } from 'knex';
import { MetaTable } from '~/utils/globals';

const WS_IDX = 'nc_audit_v2_ws_created_idx';
const BASE_IDX = 'nc_audit_v2_base_created_idx';
const USER_IDX = 'nc_audit_v2_user_created_idx';
const CREATED_IDX = 'nc_audit_v2_created_idx';

const INDEXES: [string, string[]][] = [
  [WS_IDX, ['fk_workspace_id', 'created_at', 'id']],
  [BASE_IDX, ['base_id', 'created_at', 'id']],
  // instance-wide list, and "all entries of one user"
  [CREATED_IDX, ['created_at', 'id']],
  [USER_IDX, ['user', 'created_at', 'id']],
];

const isPg = (knex: Knex) => knex.client.config.client === 'pg';

/**
 * Serve "latest audits of a workspace / base" (ORDER BY created_at DESC, id DESC)
 * without scanning the whole table. A b-tree is read backwards for DESC, so the
 * ascending index is enough.
 *
 * On Postgres the indexes are built CONCURRENTLY, so writes to the audit table
 * are not blocked. That cannot run inside a transaction: `config.transaction`
 * is false for this migration. A failed concurrent build leaves an INVALID
 * index, which is dropped before the retry.
 */
const up = async (knex: Knex) => {
  const start = Date.now();

  if (isPg(knex)) {
    for (const [name, cols] of INDEXES) {
      const { rows } = await knex.raw(
        `SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
         WHERE c.relname = ? AND c.relnamespace = current_schema()::regnamespace`,
        [name],
      );
      if (rows.length && !rows[0].indisvalid) {
        await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS ??`, [name]);
      }
      await knex.raw(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ?? ON ?? (${cols
          .map(() => '??')
          .join(', ')})`,
        [name, MetaTable.AUDIT, ...cols],
      );
    }
  } else {
    for (const [name, cols] of INDEXES) {
      try {
        await knex.schema.alterTable(MetaTable.AUDIT, (table) => {
          table.index(cols, name);
        });
      } catch {
        // index already exists
      }
    }
  }

  console.log(
    `[nc_202610131700_audit_created_at_idx] completed in ${
      Date.now() - start
    }ms`,
  );
};

const down = async (knex: Knex) => {
  for (const [name, cols] of INDEXES) {
    try {
      if (isPg(knex)) {
        await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS ??`, [name]);
      } else {
        await knex.schema.alterTable(MetaTable.AUDIT, (table) => {
          table.dropIndex(cols, name);
        });
      }
    } catch {
      // index does not exist
    }
  }
};

// CREATE INDEX CONCURRENTLY is not allowed inside a transaction.
const config = { transaction: false };

export { up, down, config };
