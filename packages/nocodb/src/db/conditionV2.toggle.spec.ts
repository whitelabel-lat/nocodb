import conditionV2 from '~/db/conditionV2';
import Filter from '~/models/Filter';

// Keep the heavy model graph and field handlers out: this test only checks WHICH
// filters conditionV2 decides to evaluate, not the SQL they produce.
jest.mock('nanoid', () => ({
  nanoid: () => 'id',
  customAlphabet: () => () => 'id',
}));
jest.mock('~/models', () => ({ Column: {}, Model: {} }));
jest.mock('~/models/Model', () => ({ __esModule: true, default: {} }));
jest.mock('~/models/Column', () => ({ __esModule: true, default: {} }));
jest.mock('~/models/Hook', () => ({ __esModule: true, default: {} }));
jest.mock('~/models/View', () => ({ __esModule: true, default: {} }));
jest.mock('~/models/ListViewLevel', () => ({ __esModule: true, default: {} }));
jest.mock('~/Noco', () => ({ __esModule: true, default: { ncMeta: {} } }));
jest.mock('~/cache/NocoCache', () => ({ __esModule: true, default: {} }));
jest.mock('~/db/generateLookupSelectQuery', () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock('~/helpers', () => ({ getRefColumnIfAlias: async (_c, col) => col }));
jest.mock('~/helpers/dbHelpers', () => ({}));
jest.mock('~/db/linkedRecordDynamicFilter', () => ({}));
jest.mock('~/helpers/conditionHelpers', () => ({}));
jest.mock('~/db/field-handler/utils/handlerUtils', () => ({}));
jest.mock('~/utils', () => ({ getAliasGenerator: jest.fn() }));
jest.mock('~/db/field-handler', () => ({
  FieldHandler: {
    fromBaseModel: () => ({ verifyFilters: async () => undefined }),
  },
}));

const context = { workspace_id: 'ws', base_id: 'bs' } as any;
const baseModelSqlv2 = { context, dbDriver: {} } as any;
const qb = { where: jest.fn() } as any;

// A leaf filter whose column lookup is observable: a filter that is evaluated
// asks for its column, a filter that is skipped never does.
function leaf(enabled: any) {
  const f = new Filter({
    id: `f-${String(enabled)}`,
    fk_column_id: 'c1',
    comparison_op: 'eq',
    value: 'x',
    ...(enabled === undefined ? {} : { enabled }),
  } as any);
  const getColumn = jest.fn().mockResolvedValue(undefined);
  (f as any).getColumn = getColumn;
  return { filter: f, getColumn };
}

function group(enabled: any, children: any[]) {
  const g = new Filter({
    id: `g-${String(enabled)}`,
    is_group: true,
    ...(enabled === undefined ? {} : { enabled }),
  } as any);
  const getChildren = jest.fn().mockResolvedValue(children);
  (g as any).getChildren = getChildren;
  return { filter: g, getChildren };
}

describe('conditionV2 enabled toggle on filters', () => {
  it('Filter.supportToggle is on in this fork', async () => {
    await expect(Filter.supportToggle(context)).resolves.toBe(true);
  });

  it.each([false, 0])('ignores a leaf filter with enabled=%p', async (v) => {
    const { filter, getColumn } = leaf(v);
    await conditionV2(baseModelSqlv2, [filter], qb);
    expect(getColumn).not.toHaveBeenCalled();
  });

  it.each([true, 1, null, undefined])(
    'keeps evaluating a leaf filter with enabled=%p',
    async (v) => {
      const { filter, getColumn } = leaf(v);
      await conditionV2(baseModelSqlv2, [filter], qb);
      expect(getColumn).toHaveBeenCalledTimes(1);
    },
  );

  it('a disabled group ignores its children, even enabled ones', async () => {
    const child = leaf(true);
    const g = group(false, [child.filter]);
    await conditionV2(baseModelSqlv2, [g.filter], qb);
    expect(g.getChildren).not.toHaveBeenCalled();
    expect(child.getColumn).not.toHaveBeenCalled();
  });

  it('a lone disabled group (not wrapped in an array) is ignored too', async () => {
    const child = leaf(true);
    const g = group(false, [child.filter]);
    await conditionV2(baseModelSqlv2, g.filter, qb);
    expect(child.getColumn).not.toHaveBeenCalled();
  });

  it('an enabled group evaluates children and skips only the disabled ones', async () => {
    const on = leaf(true);
    const off = leaf(false);
    const legacy = leaf(null);
    const g = group(undefined, [on.filter, off.filter, legacy.filter]);
    await conditionV2(baseModelSqlv2, [g.filter], qb);
    expect(g.getChildren).toHaveBeenCalledTimes(1);
    expect(on.getColumn).toHaveBeenCalledTimes(1);
    expect(legacy.getColumn).toHaveBeenCalledTimes(1);
    expect(off.getColumn).not.toHaveBeenCalled();
  });
});
