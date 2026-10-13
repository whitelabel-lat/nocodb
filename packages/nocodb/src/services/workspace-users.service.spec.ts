import { Test } from '@nestjs/testing';
import { OrgUserRoles, WorkspaceUserRoles } from 'nocodb-sdk';
import type { TestingModule } from '@nestjs/testing';
import { WorkspaceUsersService } from '~/services/workspace-users.service';
import { AppHooksService } from '~/services/app-hooks/app-hooks.service';
import { MailService } from '~/services/mail/mail.service';
import { UsersService } from '~/services/users/users.service';
import { ApiToken, Base, BaseUser } from '~/models';
import WorkspaceUser from '~/models/WorkspaceUser';
import Noco from '~/Noco';

jest.mock('~/Noco', () => ({
  __esModule: true,
  default: { ncMeta: { startTransaction: jest.fn() } },
}));

jest.mock('~/models', () => ({
  ApiToken: { list: jest.fn(), delete: jest.fn() },
  Base: { list: jest.fn() },
  BaseUser: { getProjectsIdList: jest.fn(), delete: jest.fn() },
  User: {},
}));

jest.mock('~/models/WorkspaceUser', () => ({
  __esModule: true,
  default: { get: jest.fn(), userList: jest.fn(), softDelete: jest.fn() },
}));

jest.mock('~/services/app-hooks/app-hooks.service', () => ({
  AppHooksService: jest.fn(),
}));
jest.mock('~/services/mail/mail.service', () => ({ MailService: jest.fn() }));
jest.mock('~/services/users/users.service', () => ({
  UsersService: jest.fn(),
}));
jest.mock('~/helpers/PagedResponse', () => ({ PagedResponseImpl: jest.fn() }));
jest.mock('~/helpers/validateParams', () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock('~/helpers/emailAliasHelpers', () => ({
  aliasesWithoutAccount: jest.fn(),
}));

const WS = 'ws1';

const asReq = (id: string, role: WorkspaceUserRoles, orgRole?: OrgUserRoles) =>
  ({
    user: {
      id,
      roles: orgRole ? { [orgRole]: true } : {},
      workspace_roles: { [role]: true },
    },
  } as any);

describe('WorkspaceUsersService.delete', () => {
  let service: WorkspaceUsersService;
  const trx = { commit: jest.fn(), rollback: jest.fn() };

  // In-memory stand-ins for the meta tables, so the tests can assert on the
  // end state (what the removed user can still reach) and not on call order.
  let members: Record<string, WorkspaceUserRoles>;
  let baseMembers: { fk_workspace_id: string; base_id: string; user: string }[];
  let tokens: { id: string; fk_user_id: string; base_id: string | null }[];

  beforeEach(async () => {
    jest.clearAllMocks();

    members = {
      owner1: WorkspaceUserRoles.OWNER,
      owner2: WorkspaceUserRoles.OWNER,
      creator1: WorkspaceUserRoles.CREATOR,
      creator2: WorkspaceUserRoles.CREATOR,
      viewer1: WorkspaceUserRoles.VIEWER,
    };
    baseMembers = [
      { fk_workspace_id: WS, base_id: 'b1', user: 'creator1' },
      { fk_workspace_id: WS, base_id: 'b2', user: 'creator1' },
      { fk_workspace_id: 'other', base_id: 'b9', user: 'creator1' },
    ];
    tokens = [
      { id: 't-scoped', fk_user_id: 'creator1', base_id: 'b1' },
      { id: 't-other-ws', fk_user_id: 'creator1', base_id: 'b9' },
      { id: 't-account', fk_user_id: 'creator1', base_id: null },
    ];

    (Noco.ncMeta.startTransaction as jest.Mock).mockResolvedValue(trx);
    (WorkspaceUser.get as jest.Mock).mockImplementation(
      async (_ws: string, userId: string) =>
        members[userId] ? { roles: members[userId] } : null,
    );
    (WorkspaceUser.userList as jest.Mock).mockImplementation(async () =>
      Object.entries(members).map(([id, roles]) => ({ id, roles })),
    );
    (WorkspaceUser.softDelete as jest.Mock).mockImplementation(
      async (_ws: string, userId: string) => {
        delete members[userId];
      },
    );
    (BaseUser.getProjectsIdList as jest.Mock).mockImplementation(
      async (userId: string) => baseMembers.filter((b) => b.user === userId),
    );
    (BaseUser.delete as jest.Mock).mockImplementation(
      async (_ctx: any, baseId: string, userId: string) => {
        baseMembers = baseMembers.filter(
          (b) => !(b.base_id === baseId && b.user === userId),
        );
      },
    );
    (Base.list as jest.Mock).mockResolvedValue([{ id: 'b1' }, { id: 'b2' }]);
    (ApiToken.list as jest.Mock).mockImplementation(async (userId: string) =>
      tokens.filter((t) => t.fk_user_id === userId),
    );
    (ApiToken.delete as jest.Mock).mockImplementation(async (id: string) => {
      tokens = tokens.filter((t) => t.id !== id);
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkspaceUsersService,
        { provide: AppHooksService, useValue: {} },
        { provide: UsersService, useValue: {} },
        { provide: MailService, useValue: {} },
      ],
    }).compile();

    service = module.get(WorkspaceUsersService);
  });

  const remove = (userId: string, req: any) =>
    service.delete({ workspaceId: WS, userId, req });

  it('lets an owner remove a creator and revokes what the creator reached', async () => {
    await expect(
      remove('creator1', asReq('owner1', WorkspaceUserRoles.OWNER)),
    ).resolves.toBe(true);

    // no workspace membership
    expect(members.creator1).toBeUndefined();
    // no explicit base role in this workspace, other workspaces untouched
    expect(baseMembers).toEqual([
      { fk_workspace_id: 'other', base_id: 'b9', user: 'creator1' },
    ]);
    // base-scoped token of this workspace is gone, the rest stays
    expect(tokens.map((t) => t.id)).toEqual(['t-other-ws', 't-account']);
    expect(trx.commit).toHaveBeenCalled();
    expect(trx.rollback).not.toHaveBeenCalled();
  });

  it('lets an owner remove another owner while one remains', async () => {
    await remove('owner2', asReq('owner1', WorkspaceUserRoles.OWNER));
    expect(members.owner2).toBeUndefined();
  });

  it('refuses to remove the last owner', async () => {
    delete members.owner2;

    await expect(
      remove('owner1', asReq('owner1', WorkspaceUserRoles.OWNER)),
    ).rejects.toThrow('At least one owner should be there');

    expect(members.owner1).toBe(WorkspaceUserRoles.OWNER);
    expect(Noco.ncMeta.startTransaction).not.toHaveBeenCalled();
  });

  it('refuses even a super admin when the target is the last owner', async () => {
    delete members.owner2;

    await expect(
      remove(
        'owner1',
        asReq('admin', WorkspaceUserRoles.OWNER, OrgUserRoles.SUPER_ADMIN),
      ),
    ).rejects.toThrow('At least one owner should be there');
  });

  it('lets an owner leave when another owner remains', async () => {
    await remove('owner1', asReq('owner1', WorkspaceUserRoles.OWNER));
    expect(members.owner1).toBeUndefined();
  });

  it('forbids a creator from removing an owner', async () => {
    await expect(
      remove('owner1', asReq('creator2', WorkspaceUserRoles.CREATOR)),
    ).rejects.toThrow('Insufficient privilege to remove user');

    expect(members.owner1).toBe(WorkspaceUserRoles.OWNER);
  });

  it('lets a super admin remove an owner', async () => {
    await remove(
      'owner2',
      asReq('admin', WorkspaceUserRoles.VIEWER, OrgUserRoles.SUPER_ADMIN),
    );
    expect(members.owner2).toBeUndefined();
  });

  it('fails when the user is not a member', async () => {
    await expect(
      remove('ghost', asReq('owner1', WorkspaceUserRoles.OWNER)),
    ).rejects.toThrow();
    expect(WorkspaceUser.softDelete).not.toHaveBeenCalled();
  });

  it('rolls back and keeps the membership when a step fails', async () => {
    (BaseUser.delete as jest.Mock).mockRejectedValueOnce(new Error('db down'));

    await expect(
      remove('creator1', asReq('owner1', WorkspaceUserRoles.OWNER)),
    ).rejects.toThrow('Failed to remove user from the workspace');

    expect(trx.rollback).toHaveBeenCalled();
    expect(trx.commit).not.toHaveBeenCalled();
    expect(members.creator1).toBe(WorkspaceUserRoles.CREATOR);
  });
});
