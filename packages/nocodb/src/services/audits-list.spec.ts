// CE implementation (whitelabel fork): audit listing — permission boundaries,
// filters, pagination and redaction.
// SQL tests need a throwaway Postgres: AUDIT_TEST_PG=postgres://user:pw@host:port/db (tables are dropped and recreated).
// Run: AUDIT_TEST_PG=... npx jest --testRegex 'audits-list.spec.ts$' --runInBand --forceExit
import knexFactory from 'knex';
import { OrgUserRoles, ProjectRoles, WorkspaceUserRoles } from 'nocodb-sdk';
import { OPERATION_SCOPES } from '~/controllers/internal/operationScopes';
import { AclMiddleware } from '~/middlewares/extract-ids/extract-ids.middleware';
import { AuditsService } from '~/services/audits.service';
import { redactAuditDetails } from '~/utils/auditRedaction';
import Noco from '~/Noco';

jest.mock('~/Noco', () => ({ __esModule: true, default: {} }));
// the full model graph pulls ESM-only deps; only Audit is real here
jest.mock('~/models', () => ({
  Audit: jest.requireActual('~/models/Audit').default,
  PresignedUrl: {},
}));
jest.mock('~/utils/ssrf', () => ({}));
jest.mock('~/helpers/PagedResponse', () => ({ PagedResponseImpl: jest.fn() }));
jest.mock('nanoid', () => ({
  nanoid: () => 'id',
  customAlphabet: () => () => 'id',
}));
jest.mock('~/guards/global/global.guard', () => ({ GlobalGuard: jest.fn() }));
jest.mock('~/strategies/jwt.strategy', () => ({ JwtStrategy: jest.fn() }));

const OPS = [
  'instanceAuditList',
  'workspaceAuditList',
  'baseAuditList',
] as const;

// ───────────────────────── permission boundaries ─────────────────────────
describe('audit list ACL', () => {
  const acl = new AclMiddleware({} as any, {} as any);

  const can = async (
    op: (typeof OPS)[number],
    user: { roles?: any; workspace_roles?: any; base_roles?: any },
  ) => {
    const req: any = { user: { isAuthorized: true, ...user } };
    try {
      await acl.aclFn(op, { scope: OPERATION_SCOPES[op] }, null as any, req);
      return true;
    } catch {
      return false;
    }
  };

  it('maps each operation to the intended scope', () => {
    expect(OPERATION_SCOPES.instanceAuditList).toBe('org');
    expect(OPERATION_SCOPES.workspaceAuditList).toBe('workspace');
    expect(OPERATION_SCOPES.baseAuditList).toBe('base');
  });

  it('instance audit: super admin only', async () => {
    expect(
      await can('instanceAuditList', {
        roles: { [OrgUserRoles.SUPER_ADMIN]: true },
      }),
    ).toBe(true);
    expect(
      await can('instanceAuditList', {
        roles: { [OrgUserRoles.CREATOR]: true },
      }),
    ).toBe(false);
    expect(
      await can('instanceAuditList', {
        roles: { [OrgUserRoles.VIEWER]: true },
      }),
    ).toBe(false);
  });

  it('workspace audit: workspace owner only', async () => {
    const ws = (r: WorkspaceUserRoles) => ({ workspace_roles: { [r]: true } });
    expect(await can('workspaceAuditList', ws(WorkspaceUserRoles.OWNER))).toBe(
      true,
    );
    for (const r of [
      WorkspaceUserRoles.CREATOR,
      WorkspaceUserRoles.EDITOR,
      WorkspaceUserRoles.COMMENTER,
      WorkspaceUserRoles.VIEWER,
      WorkspaceUserRoles.NO_ACCESS,
    ]) {
      expect(await can('workspaceAuditList', ws(r))).toBe(false);
    }
  });

  it('base audit: base owner and creator only', async () => {
    const b = (r: ProjectRoles) => ({ base_roles: { [r]: true } });
    expect(await can('baseAuditList', b(ProjectRoles.OWNER))).toBe(true);
    expect(await can('baseAuditList', b(ProjectRoles.CREATOR))).toBe(true);
    for (const r of [
      ProjectRoles.EDITOR,
      ProjectRoles.COMMENTER,
      ProjectRoles.VIEWER,
      ProjectRoles.APP_USER,
    ]) {
      expect(await can('baseAuditList', b(r))).toBe(false);
    }
  });

  it('base viewers/editors are not let in by a workspace audit or vice versa', async () => {
    expect(
      await can('workspaceAuditList', {
        base_roles: { [ProjectRoles.OWNER]: true },
      }),
    ).toBe(false);
    expect(
      await can('baseAuditList', {
        workspace_roles: { [WorkspaceUserRoles.OWNER]: true },
      }),
    ).toBe(false);
  });

  it('public shared base sessions are blocked', async () => {
    const req: any = {
      user: {
        isAuthorized: true,
        isPublicBase: true,
        base_roles: { [ProjectRoles.OWNER]: true },
      },
    };
    await expect(
      acl.aclFn(
        'baseAuditList',
        { scope: 'base', blockPublicBaseAccess: true },
        null as any,
        req,
      ),
    ).rejects.toBeDefined();
  });
});

// ───────────────────────── filters / pagination ─────────────────────────
const PG_URL = process.env.AUDIT_TEST_PG;
(PG_URL ? describe : describe.skip)('AuditsService.auditList', () => {
  const knex = knexFactory({
    client: 'pg',
    connection: PG_URL || 'postgres://x',
  });
  const service = new AuditsService({} as any, {} as any);

  const ts = (s: number) =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, s))
      .toISOString()
      .replace('T', ' ')
      .replace('.000Z', '+00:00');

  const row = (i: number, o: Record<string, any> = {}) => ({
    id: `0190-${String(i).padStart(6, '0')}`,
    user: i % 2 ? 'a@x.com' : 'b@x.com',
    fk_user_id: i % 2 ? 'u1' : 'u2',
    fk_workspace_id: 'ws1',
    base_id: i % 3 ? 'b1' : 'b2',
    fk_model_id: i % 2 ? 'm1' : 'm2',
    row_id: String(i),
    op_type: i % 4 ? 'DATA_UPDATE' : 'DATA_INSERT',
    created_at: ts(i),
    details: '{}',
    version: 1,
    ...o,
  });

  beforeAll(async () => {
    for (const t of ['nc_audit_v2', 'nc_bases_v2', 'nc_models_v2'])
      await knex.schema.dropTableIfExists(t);
    await knex.schema.createTable('nc_audit_v2', (t) => {
      t.string('id').primary();
      [
        'user',
        'ip',
        'source_id',
        'fk_workspace_id',
        'base_id',
        'fk_model_id',
        'row_id',
        'op_type',
        'op_sub_type',
        'fk_user_id',
        'description',
        'details',
      ].forEach((c) => t.text(c));
      t.timestamp('created_at', { useTz: true });
      t.integer('version');
    });
    await knex.schema.createTable('nc_bases_v2', (t) => {
      t.string('id');
      t.string('title');
    });
    await knex.schema.createTable('nc_models_v2', (t) => {
      t.string('id');
      t.string('title');
    });
    await knex('nc_bases_v2').insert([{ id: 'b1', title: 'Base One' }]);
    await knex('nc_models_v2').insert([{ id: 'm1', title: 'Table One' }]);
    const rows = Array.from({ length: 60 }, (_, i) => row(i + 1));
    rows.push(
      row(100, {
        fk_workspace_id: 'ws2',
        base_id: 'b9',
        op_type: 'DATA_DELETE',
      }),
    );
    await knex('nc_audit_v2').insert(rows);
    // `Noco.ncAudit`/`ncMeta` both point at the same in-memory db
    const meta = {
      knex,
      knexConnection: knex,
      formatDateTime: (d: string) =>
        new Date(d).toISOString().replace('T', ' ').replace('.000Z', '+00:00'),
    };
    (Noco as any).ncAudit = meta;
    (Noco as any).ncMeta = meta;
  });
  afterAll(async () => {
    if (PG_URL) await knex.destroy();
  });

  it('workspace scope never leaks another workspace and sorts newest first', async () => {
    const res = await service.auditList(
      { kind: 'workspace', workspaceId: 'ws1' },
      { limit: 100 },
    );
    expect(res.list).toHaveLength(60);
    expect(res.list.every((r) => r.fk_workspace_id === 'ws1')).toBe(true);
    expect(res.list[0].row_id).toBe('60');
    expect(res.list[59].row_id).toBe('1');
    expect(res.pageInfo.isLastPage).toBe(true);
  });

  it('caps the page size and paginates by cursor without gaps or repeats', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res: any = await service.auditList(
        { kind: 'workspace', workspaceId: 'ws1' },
        { limit: 1000, cursor },
      );
      expect(res.list.length).toBeLessThanOrEqual(100);
      seen.push(...res.list.map((r: any) => r.id));
      cursor = res.pageInfo.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(new Set(seen).size).toBe(60);

    const small: string[] = [];
    cursor = undefined;
    do {
      const res: any = await service.auditList(
        { kind: 'workspace', workspaceId: 'ws1' },
        { limit: 25, cursor },
      );
      small.push(...res.list.map((r: any) => r.id));
      cursor = res.pageInfo.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(small).toHaveLength(60);
    expect(new Set(small).size).toBe(60);
  });

  it('keeps ordering stable when many rows share one created_at', async () => {
    await knex('nc_audit_v2').insert(
      Array.from({ length: 5 }, (_, i) =>
        row(200 + i, { fk_workspace_id: 'ws3', created_at: ts(500) }),
      ),
    );
    const p1: any = await service.auditList(
      { kind: 'workspace', workspaceId: 'ws3' },
      { limit: 2 },
    );
    const p2: any = await service.auditList(
      { kind: 'workspace', workspaceId: 'ws3' },
      { limit: 2, cursor: p1.pageInfo.nextCursor },
    );
    const p3: any = await service.auditList(
      { kind: 'workspace', workspaceId: 'ws3' },
      { limit: 2, cursor: p2.pageInfo.nextCursor },
    );
    const ids = [...p1.list, ...p2.list, ...p3.list].map((r: any) => r.id);
    expect(new Set(ids).size).toBe(5);
    expect(p3.pageInfo.isLastPage).toBe(true);
  });

  it('filters by user (email, case-insensitive, or id), base, table, op type and dates', async () => {
    const ws = { kind: 'workspace', workspaceId: 'ws1' } as const;
    const all = async (p: any) =>
      (await service.auditList(ws, { limit: 100, ...p })).list;

    expect(
      (await all({ user: 'A@X.com' })).every((r) => r.user === 'a@x.com'),
    ).toBe(true);
    expect(
      (await all({ user: 'u2' })).every((r) => r.fk_user_id === 'u2'),
    ).toBe(true);
    expect(
      (await all({ base_id: 'b1' })).every((r) => r.base_id === 'b1'),
    ).toBe(true);
    expect(
      (await all({ fk_model_id: 'm1' })).every((r) => r.fk_model_id === 'm1'),
    ).toBe(true);
    expect(
      (await all({ op_type: 'DATA_INSERT' })).every(
        (r) => r.op_type === 'DATA_INSERT',
      ),
    ).toBe(true);
    expect((await all({ op_type: 'DATA_INSERT,DATA_DELETE' })).length).toBe(15);

    const ranged = await all({
      from: '2026-01-01T00:00:10Z',
      to: '2026-01-01T00:00:20Z',
    });
    expect(ranged.map((r) => Number(r.row_id)).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 11 }, (_, i) => 10 + i),
    );
  });

  it('base scope is pinned to its base and cannot be widened by a filter', async () => {
    const res = await service.auditList(
      { kind: 'base', baseId: 'b1', workspaceId: 'ws1' },
      { limit: 100 },
    );
    expect(res.list.length).toBeGreaterThan(0);
    expect(res.list.every((r) => r.base_id === 'b1')).toBe(true);
    expect(res.list[0].base_title).toBe('Base One');
    expect(res.list.find((r) => r.fk_model_id === 'm1')?.table_title).toBe(
      'Table One',
    );
    await expect(
      service.auditList(
        { kind: 'base', baseId: 'b1', workspaceId: 'ws1' },
        { base_id: 'b2' },
      ),
    ).rejects.toBeDefined();
    // base of another workspace is empty even when the base id matches
    const other = await service.auditList(
      { kind: 'base', baseId: 'b1', workspaceId: 'ws2' },
      {},
    );
    expect(other.list).toHaveLength(0);
  });

  it('instance scope sees every workspace and can narrow to one', async () => {
    const res = await service.auditList({ kind: 'instance' }, { limit: 100 });
    expect(
      new Set(res.list.map((r) => r.fk_workspace_id)).size,
    ).toBeGreaterThan(1);
    const one = await service.auditList(
      { kind: 'instance', workspaceId: 'ws2' },
      {},
    );
    expect(one.list).toHaveLength(1);
  });

  it('rejects malformed input and does not interpolate it into SQL', async () => {
    const ws = { kind: 'workspace', workspaceId: 'ws1' } as const;
    for (const bad of [
      { fk_model_id: "m1' OR '1'='1" },
      { base_id: 'b1; drop table nc_audit_v2' },
      { op_type: 'x y' },
      { from: 'not-a-date' },
      { cursor: 'garbage' },
      { limit: '0' },
      { limit: 'abc' },
    ]) {
      await expect(service.auditList(ws, bad as any)).rejects.toBeDefined();
    }
    expect(await knex.schema.hasTable('nc_audit_v2')).toBe(true);
    // user filter is a bound value
    const res = await service.auditList(ws, { user: "' OR 1=1 --" });
    expect(res.list).toHaveLength(0);
  });

  it('redacts secrets in details and description', async () => {
    await knex('nc_audit_v2').insert(
      row(300, {
        fk_workspace_id: 'ws4',
        description: 'login with Bearer abc.def.ghi',
        details: JSON.stringify({
          data: {
            Title: 'ok',
            Password: 'hunter2',
            api_key: 'k',
            nested: { access_token: 't', url: 'https://s/x?token=abc&a=1' },
          },
          column_meta: {
            Password: { id: 'c1', title: 'Password', type: 'SingleLineText' },
          },
        }),
      }),
    );
    const res = await service.auditList(
      { kind: 'workspace', workspaceId: 'ws4' },
      {},
    );
    const text = res.list[0].details as string;
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('"k"');
    expect(text).not.toContain('"t"');
    expect(text).not.toContain('token=abc');
    expect(text).toContain('"Title":"ok"');
    expect(text).toContain('column_meta');
    expect(res.list[0].description).not.toContain('abc.def.ghi');
  });
});

describe('redactAuditDetails', () => {
  it('replaces oversized payloads with a marker', () => {
    const out = JSON.parse(redactAuditDetails('x'.repeat(200_000)) as string);
    expect(out.truncated).toBe(true);
  });
  it('masks JWTs inside text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk';
    expect(redactAuditDetails({ msg: `x ${jwt}` })).not.toContain(jwt);
  });
});
