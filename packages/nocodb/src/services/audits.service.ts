import { Injectable } from '@nestjs/common';
import { UITypes } from 'nocodb-sdk';
import type { NcContext } from '~/interface/config';
import { AppHooksListenerService } from '~/services/app-hooks-listener.service';
import { Audit, PresignedUrl } from '~/models';
import { AppHooksService } from '~/services/app-hooks/app-hooks.service';
import { processConcurrently } from '~/utils/dataUtils';
import { NcError } from '~/helpers/catchError';
import Noco from '~/Noco';
import { MetaTable } from '~/utils/globals';
import { redactAuditDetails, redactAuditString } from '~/utils/auditRedaction';

// CE implementation (whitelabel fork)
export type AuditListScope =
  | { kind: 'instance'; workspaceId?: string }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'base'; workspaceId?: string; baseId: string };

export interface AuditListParams {
  user?: string;
  base_id?: string;
  fk_model_id?: string;
  row_id?: string;
  op_type?: string | string[];
  op_sub_type?: string | string[];
  from?: string;
  to?: string;
  cursor?: string;
  limit?: string | number;
}

const ID_RE = /^[\w-]{1,64}$/;
const OP_RE = /^[A-Z0-9_]{1,64}$/;

function toList(v: string | string[] | undefined): string[] {
  if (v === undefined || v === '') return [];
  return (Array.isArray(v) ? v : String(v).split(',')).map((x) => x.trim());
}

function toId(name: string, v?: string) {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !ID_RE.test(v)) {
    NcError.badRequest(`Invalid ${name}`);
  }
  return v;
}

function toDate(name: string, v?: string) {
  if (!v) return undefined;
  const d = new Date(v);
  if (typeof v !== 'string' || Number.isNaN(d.getTime())) {
    NcError.badRequest(`Invalid ${name}`);
  }
  return d;
}

@Injectable()
export class AuditsService {
  constructor(
    protected readonly appHooksListenerService: AppHooksListenerService,
    protected readonly appHooksService: AppHooksService,
  ) {}

  async recordAuditList(
    context: NcContext,
    param: {
      row_id: string;
      fk_model_id: string;
      cursor?: string;
      retentionLimit?: number;
    },
  ) {
    const audits = await Audit.recordAuditList(context, param);

    for (const audit of audits.list) {
      try {
        const details = JSON.parse(audit.details || '{}');
        const { column_meta, data, old_data } = details as {
          column_meta: Record<
            string,
            { id: string; title: string; type: string }
          >;
          data: Record<string, any>;
          old_data: Record<string, any>;
        };

        for (const col of Object.values(column_meta || {})) {
          // re-generate new signedUrl for attachment files
          // to prevent it from expiring when displayed
          if (col.type === UITypes.Attachment) {
            if (data && data[col.title]) {
              await processConcurrently(
                data[col.title],
                async (item: any) => {
                  try {
                    await PresignedUrl.signAttachment({
                      attachment: item,
                      filename: item.title,
                    });
                  } catch (e) {}
                },
                15,
              );
            }

            if (old_data && old_data[col.title]) {
              await processConcurrently(
                old_data[col.title],
                async (item: any) => {
                  try {
                    await PresignedUrl.signAttachment({
                      attachment: item,
                      filename: item.title,
                    });
                  } catch (e) {}
                },
                15,
              );
            }
          }
        }

        audit.details = JSON.stringify(details);
      } catch (e) {}
    }

    return audits;
  }

  // CE implementation (whitelabel fork)
  /**
   * Audit listing for admins (instance), workspace owners and base owners/creators.
   * The caller has already passed the ACL for the scope; the scope columns come
   * from the resolved request context, never from the query string.
   */
  async auditList(scope: AuditListScope, params: AuditListParams) {
    if (scope.kind === 'workspace' && !scope.workspaceId) {
      NcError.badRequest('Workspace is required');
    }
    if (scope.kind === 'base' && !scope.baseId) {
      NcError.badRequest('Base is required');
    }

    const limit = Number(params.limit ?? Audit.DEFAULT_PAGE_SIZE);
    if (!Number.isInteger(limit) || limit < 1) {
      NcError.badRequest('Invalid limit');
    }

    const opTypes = toList(params.op_type);
    const opSubTypes = toList(params.op_sub_type);
    if ([...opTypes, ...opSubTypes].some((o) => !OP_RE.test(o))) {
      NcError.badRequest('Invalid operation type');
    }

    let cursor: { createdAt: string; id: string } | undefined;
    if (params.cursor) {
      const idx = String(params.cursor).indexOf('|');
      const createdAt = String(params.cursor).slice(0, idx);
      const id = String(params.cursor).slice(idx + 1);
      if (
        idx < 0 ||
        Number.isNaN(new Date(createdAt).getTime()) ||
        !ID_RE.test(id)
      ) {
        NcError.badRequest('Invalid cursor');
      }
      cursor = { createdAt, id };
    }

    const user = params.user ? String(params.user).trim() : undefined;
    if (user && user.length > 255) NcError.badRequest('Invalid user');

    // a base-scoped caller can only look at its own base
    const baseFilter = toId('base_id', params.base_id);
    if (scope.kind === 'base' && baseFilter && baseFilter !== scope.baseId) {
      NcError.badRequest('Invalid base_id');
    }

    const { rows, hasMore } = await Audit.list(
      {
        workspaceId: scope.workspaceId,
        baseId: scope.kind === 'base' ? scope.baseId : undefined,
      },
      {
        user,
        baseId: baseFilter,
        modelId: toId('fk_model_id', params.fk_model_id),
        rowId: params.row_id ? String(params.row_id).slice(0, 255) : undefined,
        opTypes,
        opSubTypes,
        from: toDate('from', params.from),
        to: toDate('to', params.to),
        cursor,
        limit,
      },
    );

    const baseIds = [...new Set(rows.map((r) => r.base_id).filter(Boolean))];
    const modelIds = [
      ...new Set(rows.map((r) => r.fk_model_id).filter(Boolean)),
    ];
    const [bases, models] = await Promise.all([
      baseIds.length
        ? Noco.ncMeta
            .knexConnection(MetaTable.PROJECT)
            .whereIn('id', baseIds)
            .select('id', 'title')
        : [],
      modelIds.length
        ? Noco.ncMeta
            .knexConnection(MetaTable.MODELS)
            .whereIn('id', modelIds)
            .select('id', 'title')
        : [],
    ]);
    const baseTitle = new Map(bases.map((b: any) => [b.id, b.title]));
    const modelTitle = new Map(models.map((m: any) => [m.id, m.title]));

    const list = rows.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      user: r.user,
      fk_user_id: r.fk_user_id,
      ip: r.ip,
      fk_workspace_id: r.fk_workspace_id,
      base_id: r.base_id,
      base_title: baseTitle.get(r.base_id),
      source_id: r.source_id,
      fk_model_id: r.fk_model_id,
      table_title: modelTitle.get(r.fk_model_id),
      row_id: r.row_id,
      op_type: r.op_type,
      op_sub_type: r.op_sub_type,
      description: r.description
        ? redactAuditString(r.description)
        : r.description,
      details: redactAuditDetails(r.details),
      version: r.version,
    }));

    const last = rows[rows.length - 1] as any;
    const lastTs = last
      ? last.created_at instanceof Date
        ? last.created_at.toISOString()
        : String(last.created_at)
      : undefined;

    return {
      list,
      pageInfo: {
        isLastPage: !hasMore,
        pageSize: limit > Audit.MAX_PAGE_SIZE ? Audit.MAX_PAGE_SIZE : limit,
        nextCursor: hasMore && last ? `${lastTs}|${last.id}` : null,
      },
    };
  }
}
