import { type AuditV1OperationTypes } from 'nocodb-sdk';
import type { NcContext } from '~/interface/config';
import Noco from '~/Noco';
import { extractProps } from '~/helpers/extractProps';
import { MetaTable, RootScopes } from '~/utils/globals';
import { stringifyMetaProp } from '~/utils/modelUtils';
import { PagedResponseImpl } from '~/helpers/PagedResponse';

export default class Audit {
  id?: string;
  user?: string;
  fk_user_id?: string;
  user_agent?: string;
  ip?: string;
  source_id?: string;
  fk_workspace_id?: string;
  fk_org_id?: string;
  base_id?: string;
  fk_model_id?: string;
  row_id?: string;
  op_type?: AuditV1OperationTypes;
  description?: string;
  details?: any;
  version?: number;
  fk_parent_id?: string;
  op_sub_type?: string;
  created_at?: Date | string;

  protected static limit = 25;

  constructor(audit: Partial<Audit>) {
    Object.assign(this, audit);
  }

  public static async get(auditId: string, ncAudit = Noco.ncAudit) {
    const audit = await ncAudit.metaGet2(
      RootScopes.ROOT,
      RootScopes.ROOT,
      MetaTable.AUDIT,
      auditId,
    );
    return audit && new Audit(audit);
  }

  // Will only await for Audit insertion if `forceAwait` is true, which will be true in test environment by default
  public static async insert(
    audit: Partial<Audit> | Partial<Audit>[],
    ncAudit = Noco.ncAudit,
    {
      forceAwait,
      catchException = false,
    }: { forceAwait: boolean; catchException?: boolean } = {
      forceAwait: process.env['TEST'] === 'true',
    },
  ) {
    try {
      if (process.env.NC_DISABLE_AUDIT === 'true') {
        return;
      }
      const propsToExtract = [
        'id',
        'user',
        'ip',
        'source_id',
        'fk_workspace_id',
        'fk_org_id',
        'base_id',
        'row_id',
        'fk_model_id',
        'op_type',
        'op_sub_type',
        'description',
        'details',
        'user_agent',
        'version',
        'fk_user_id',
        'fk_ref_id',
        'fk_parent_id',
      ];

      const insertAudit = async () => {
        if (Array.isArray(audit)) {
          const insertObjs = audit
            .filter((k) => k)
            .map((a) => ({
              ...extractProps(a, propsToExtract),
              details: stringifyMetaProp(a, 'details'),
            }));

          return await ncAudit.bulkMetaInsert(
            RootScopes.ROOT,
            RootScopes.ROOT,
            MetaTable.AUDIT,
            insertObjs,
          );
        } else {
          const insertObj = extractProps(audit, propsToExtract);

          return await ncAudit.metaInsert2(
            RootScopes.ROOT,
            RootScopes.ROOT,
            MetaTable.AUDIT,
            { ...insertObj, details: stringifyMetaProp(insertObj, 'details') },
          );
        }
      };

      if (forceAwait) {
        return await insertAudit();
      } else {
        insertAudit().catch((e) => {
          console.error('Error inserting audit', e);
        });
        return;
      }
    } catch (e) {
      if (!catchException) {
        console.error('Error inserting audit', e);
      } else {
        throw e;
      }
    }
  }

  public static async recordAuditList(
    context: NcContext,
    {
      fk_model_id,
      row_id,
      cursor,
    }: {
      fk_model_id: string;
      row_id: string;
      cursor?: string;
    },
  ): Promise<PagedResponseImpl<Audit>> {
    if (!context.base_id || !fk_model_id || !row_id) {
      return new PagedResponseImpl([], {}, { pageInfo: { isLastPage: true } });
    }

    const [id, _created_at] = cursor?.split('|') ?? [];

    const query = Noco.ncAudit.knex(MetaTable.AUDIT);

    if (context.workspace_id) {
      query.where('fk_workspace_id', context.workspace_id);
    }

    query
      .where('base_id', context.base_id)
      .where('fk_model_id', fk_model_id)
      .where('row_id', row_id)
      .orderBy('id', 'desc');

    if (id) {
      query.where('id', '<', id);
    }

    query.limit(this.limit + 1);

    const audits = await query;

    if (audits.length > this.limit) {
      audits.pop();
      return new PagedResponseImpl(
        audits,
        {},
        { pageInfo: { isLastPage: false } },
      );
    }

    return new PagedResponseImpl(
      audits,
      {},
      { pageInfo: { isLastPage: true } },
    );
  }

  static readonly MAX_PAGE_SIZE = 100;
  static readonly DEFAULT_PAGE_SIZE = 25;

  // CE implementation (whitelabel fork)
  /**
   * Keyset-paginated listing, newest first (created_at desc, id desc).
   * Scope columns (workspace / base) come from the caller's resolved context,
   * never from user input; `filters` only narrow within that scope.
   */
  public static async list(
    scope: { workspaceId?: string; baseId?: string },
    filters: {
      user?: string;
      baseId?: string;
      modelId?: string;
      rowId?: string;
      opTypes?: string[];
      opSubTypes?: string[];
      from?: Date;
      to?: Date;
      cursor?: { createdAt: string; id: string };
      limit?: number;
    },
    ncAudit = Noco.ncAudit,
  ): Promise<{ rows: Audit[]; hasMore: boolean }> {
    const limit = Math.min(
      Math.max(1, filters.limit ?? this.DEFAULT_PAGE_SIZE),
      this.MAX_PAGE_SIZE,
    );
    const isPg = ncAudit.knex.client.config.client === 'pg';
    // pg parses ISO strings; other clients store 'YYYY-MM-DD HH:mm:ss(Z)'
    const ts = (d: Date | string) =>
      isPg
        ? new Date(d).toISOString()
        : ncAudit.formatDateTime(new Date(d).toISOString());

    const query = ncAudit.knex(MetaTable.AUDIT);

    if (scope.workspaceId) query.where('fk_workspace_id', scope.workspaceId);
    if (scope.baseId) query.where('base_id', scope.baseId);
    if (filters.baseId) query.where('base_id', filters.baseId);
    if (filters.modelId) query.where('fk_model_id', filters.modelId);
    if (filters.rowId) query.where('row_id', filters.rowId);
    if (filters.opTypes?.length) query.whereIn('op_type', filters.opTypes);
    if (filters.opSubTypes?.length)
      query.whereIn('op_sub_type', filters.opSubTypes);
    if (filters.user) {
      // Emails match `user` (index friendly: exact, as typed or lower-cased);
      // anything else is treated as a user id.
      if (filters.user.includes('@')) {
        query.whereIn('user', [
          ...new Set([filters.user, filters.user.toLowerCase()]),
        ]);
      } else {
        query.where('fk_user_id', filters.user);
      }
    }
    if (filters.from) query.where('created_at', '>=', ts(filters.from));
    if (filters.to) query.where('created_at', '<=', ts(filters.to));
    if (filters.cursor) {
      const { createdAt, id } = filters.cursor;
      query.where(function () {
        this.where('created_at', '<', ts(createdAt)).orWhere(function () {
          this.where('created_at', ts(createdAt)).andWhere('id', '<', id);
        });
      });
    }

    const rows = await query
      .select(
        'id',
        'user',
        'fk_user_id',
        'ip',
        'source_id',
        'fk_workspace_id',
        'base_id',
        'fk_model_id',
        'row_id',
        'op_type',
        'op_sub_type',
        'description',
        'details',
        'version',
        'created_at',
      )
      .orderBy([
        { column: 'created_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return { rows: rows.map((r) => new Audit(r)), hasMore };
  }

  // TODO: remove this - it is deprecated and only used on unit tests
  static async baseAuditList(
    context: NcContext,
    {
      page = 1,
      user,
      type,
      startDate,
      endDate,
      orderBy,
    }: {
      page?: number;
      user?: string;
      type?: string[];
      startDate?: string;
      endDate?: string;
      orderBy?: {
        created_at?: 'asc' | 'desc';
      };
    },
  ) {
    const offset = (Math.max(1, page ?? 1) - 1) * this.limit;

    if (!context.base_id) {
      console.error('Invalid context for baseAuditList', context);
      return [];
    }

    if (orderBy?.created_at) {
      orderBy.created_at = orderBy.created_at === 'asc' ? 'asc' : 'desc';
    }

    return await Noco.ncAudit.metaList2(
      RootScopes.ROOT,
      RootScopes.ROOT,
      MetaTable.AUDIT,
      {
        limit: this.limit,
        offset,
        orderBy: {
          ...(orderBy?.created_at
            ? { id: orderBy?.created_at }
            : { id: 'desc' }),
        },
        xcCondition: {
          _and: [
            ...(context.workspace_id
              ? [{ fk_workspace_id: { eq: context.workspace_id } }]
              : []),
            { base_id: { eq: context.base_id } },
            { version: { eq: 1 } },
            ...(user ? [{ user: { eq: user } }] : []),
            ...(startDate ? [{ created_at: { ge: startDate } }] : []),
            ...(endDate ? [{ created_at: { le: endDate } }] : []),
            ...(type ? [{ op_type: { in: type } }] : []),
          ],
        },
      },
    );
  }
}
