import {
  validateCondition,
  hasActiveCondition,
} from '~/helpers/webhookHelpers';

// Keep the model graph and the webhook invoker out: only the decision of which
// filters a webhook condition evaluates is under test.
jest.mock('~/models', () => {
  class Filter {
    constructor(data: any) {
      Object.assign(this, data);
    }
  }
  return { Filter };
});
jest.mock('~/utils', () => ({ populateUpdatePayloadDiff: jest.fn() }));
jest.mock('~/utils/webhook-invoker', () => ({ WebhookInvoker: class {} }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Filter } = require('~/models');

const context = { workspace_id: 'ws', base_id: 'bs' } as any;
const opts = { client: 'pg' };

// Leaf `Title eq <value>`; its column lookup is observable so a skipped filter
// can be told apart from an evaluated one.
function leaf(value: string, enabled?: any, logical_op = 'and') {
  const f = new Filter({
    fk_column_id: 'c1',
    comparison_op: 'eq',
    value,
    logical_op,
    ...(enabled === undefined ? {} : { enabled }),
  });
  f.getColumn = jest
    .fn()
    .mockResolvedValue({ title: 'Title', uidt: 'SingleLineText' });
  return f;
}

function group(children: any[], enabled?: any, logical_op = 'and') {
  const g = new Filter({
    is_group: true,
    logical_op,
    ...(enabled === undefined ? {} : { enabled }),
  });
  g.getChildren = jest.fn().mockResolvedValue(children);
  return g;
}

const row = { Title: 'a' };

describe('webhook condition honors filter `enabled`', () => {
  it('ignores a disabled leaf', async () => {
    const off = leaf('zzz', false);
    expect(await validateCondition(context, [leaf('a'), off], row, opts)).toBe(
      true,
    );
    expect(off.getColumn).not.toHaveBeenCalled();
  });

  it('treats enabled 0 as disabled', async () => {
    expect(
      await validateCondition(context, [leaf('a'), leaf('zzz', 0)], row, opts),
    ).toBe(true);
  });

  it('a disabled "or" leaf does not make the condition pass', async () => {
    expect(
      await validateCondition(
        context,
        [leaf('zzz'), leaf('a', false, 'or')],
        row,
        opts,
      ),
    ).toBe(false);
  });

  it('a disabled group ignores its children', async () => {
    const child = leaf('zzz');
    const g = group([child], false);
    expect(await validateCondition(context, [leaf('a'), g], row, opts)).toBe(
      true,
    );
    expect(g.getChildren).not.toHaveBeenCalled();
    expect(child.getColumn).not.toHaveBeenCalled();
  });

  it('a group whose children are all disabled is ignored', async () => {
    const g = group([leaf('zzz', false)], undefined, 'not');
    expect(await validateCondition(context, [leaf('a'), g], row, opts)).toBe(
      true,
    );
  });

  it('all filters disabled => condition passes', async () => {
    expect(
      await validateCondition(
        context,
        [leaf('zzz', false), group([leaf('zzz')], 0)],
        row,
        opts,
      ),
    ).toBe(true);
  });

  it('null / undefined enabled stays active', async () => {
    expect(
      await validateCondition(context, [leaf('zzz', null)], row, opts),
    ).toBe(false);
    expect(
      await validateCondition(context, [leaf('zzz', undefined)], row, opts),
    ).toBe(false);
  });

  describe('hasActiveCondition', () => {
    it('is false for no filters or only disabled ones', async () => {
      expect(await hasActiveCondition(context, [])).toBe(false);
      expect(
        await hasActiveCondition(context, [
          leaf('a', false),
          group([leaf('a')], false),
          group([leaf('a', 0)]),
        ]),
      ).toBe(false);
    });

    it('is true when any active leaf remains', async () => {
      expect(
        await hasActiveCondition(context, [
          leaf('a', false),
          group([leaf('a', null)]),
        ]),
      ).toBe(true);
    });
  });
});
