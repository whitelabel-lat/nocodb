// CE implementation (whitelabel fork)
import { Injectable } from '@nestjs/common';
import type { OPERATION_SCOPES } from '~/controllers/internal/operationScopes';
import type { NcContext, NcRequest } from 'nocodb-sdk';
import type {
  InternalApiModule,
  InternalGETResponseType,
} from '~/utils/internal-type';
import type { AuditListScope } from '~/services/audits.service';
import { AuditsService } from '~/services/audits.service';
import { NcError } from '~/helpers/catchError';
import { RootScopes } from '~/utils/globals';

const isRealId = (id?: string) =>
  !!id && !Object.values(RootScopes).includes(id as RootScopes);

/**
 * Audit listing, one operation per scope. The ACL gate (operationScopes +
 * utils/acl.ts) decides who may call each one:
 *  - instanceAuditList:  super admin only (org scope)
 *  - workspaceAuditList: workspace owner (workspace scope)
 *  - baseAuditList:      base owner / creator (base scope)
 */
@Injectable()
export class AuditListOperations
  implements InternalApiModule<InternalGETResponseType>
{
  constructor(protected readonly auditsService: AuditsService) {}
  operations = [
    'instanceAuditList' as const,
    'workspaceAuditList' as const,
    'baseAuditList' as const,
  ];
  httpMethod = 'GET' as const;

  // Rows carry user emails and IPs: never reachable from a public shared base.
  publicBaseBlockedOperations = [
    'instanceAuditList' as const,
    'workspaceAuditList' as const,
    'baseAuditList' as const,
  ];

  async handle(
    context: NcContext,
    {
      operation,
      req,
    }: {
      workspaceId: string;
      baseId: string;
      operation: keyof typeof OPERATION_SCOPES;
      payload: any;
      req: NcRequest;
    },
  ): InternalGETResponseType {
    let scope: AuditListScope;

    switch (operation) {
      case 'instanceAuditList': {
        const ws = req.query.workspace_id as string | undefined;
        scope = { kind: 'instance', workspaceId: ws || undefined };
        break;
      }
      case 'workspaceAuditList':
        if (!isRealId(context.workspace_id))
          NcError.badRequest('Invalid workspace');
        scope = { kind: 'workspace', workspaceId: context.workspace_id };
        break;
      case 'baseAuditList':
        if (!isRealId(context.base_id)) NcError.badRequest('Invalid base');
        scope = {
          kind: 'base',
          baseId: context.base_id,
          workspaceId: isRealId(context.workspace_id)
            ? context.workspace_id
            : undefined,
        };
        break;
      default:
        return NcError.notFound('Operation not found') as never;
    }

    return await this.auditsService.auditList(scope, req.query as any);
  }
}
