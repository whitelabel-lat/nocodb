import FormView from '~/models/FormView';
import NocoCache from '~/cache/NocoCache';

// Keep the model graph out of this unit test: only the write-path validation
// of FormView is under test.
jest.mock('~/models', () => ({ PresignedUrl: {} }));
jest.mock('~/models/FormViewColumn', () => ({ __esModule: true, default: {} }));
jest.mock('~/models/View', () => ({
  __esModule: true,
  default: { get: jest.fn().mockResolvedValue({ source_id: 's' }) },
}));
jest.mock('~/Noco', () => ({ __esModule: true, default: { ncMeta: {} } }));

jest.mock('~/cache/NocoCache', () => ({
  __esModule: true,
  default: { update: jest.fn(), get: jest.fn(), set: jest.fn() },
}));

const context = { workspace_id: 'ws', base_id: 'bs' } as any;

describe('FormView redirect_url validation (write path)', () => {
  const ncMeta = { metaUpdate: jest.fn(), metaInsert2: jest.fn() } as any;

  beforeEach(() => jest.clearAllMocks());

  it.each([
    'javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,x',
    '/relative',
    '//evil.example.com',
  ])('update rejects %p and does not touch the db', async (url) => {
    await expect(
      FormView.update(context, 'view1', { redirect_url: url }, ncMeta),
    ).rejects.toThrow(/Invalid redirect_url/);
    expect(ncMeta.metaUpdate).not.toHaveBeenCalled();
  });

  it('update accepts an absolute https url', async () => {
    await FormView.update(
      context,
      'view1',
      { redirect_url: 'https://example.com/thanks?id={record_id}' },
      ncMeta,
    );
    expect(ncMeta.metaUpdate).toHaveBeenCalledTimes(1);
    expect(NocoCache.update).toHaveBeenCalled();
  });

  it('update lets an empty redirect_url through (clearing the field)', async () => {
    await FormView.update(context, 'view1', { redirect_url: '' }, ncMeta);
    expect(ncMeta.metaUpdate).toHaveBeenCalledTimes(1);
  });

  it.each(['', '   ', '\t \n'])(
    'update stores null for blank redirect_url %p',
    async (url) => {
      await FormView.update(context, 'view1', { redirect_url: url }, ncMeta);
      expect(ncMeta.metaUpdate).toHaveBeenCalledTimes(1);
      expect(ncMeta.metaUpdate.mock.calls[0][3].redirect_url).toBeNull();
    },
  );

  it('update stores the trimmed redirect_url', async () => {
    await FormView.update(
      context,
      'view1',
      { redirect_url: '  https://example.com/thanks  ' },
      ncMeta,
    );
    expect(ncMeta.metaUpdate.mock.calls[0][3].redirect_url).toBe(
      'https://example.com/thanks',
    );
  });

  it('update leaves redirect_url untouched when not in the body', async () => {
    await FormView.update(context, 'view1', { heading: 'h' }, ncMeta);
    expect('redirect_url' in ncMeta.metaUpdate.mock.calls[0][3]).toBe(false);
  });

  it.each([
    ['   ', null],
    ['  https://example.com/x ', 'https://example.com/x'],
  ])('insert normalizes redirect_url %p', async (url, expected) => {
    await FormView.insert(
      context,
      { fk_view_id: 'v', source_id: 's', redirect_url: url } as any,
      ncMeta,
    ).catch(() => undefined); // the trailing get() is not mocked
    expect(ncMeta.metaInsert2).toHaveBeenCalledTimes(1);
    expect(ncMeta.metaInsert2.mock.calls[0][3].redirect_url).toBe(expected);
  });

  it('insert rejects javascript: urls', async () => {
    await expect(
      FormView.insert(
        context,
        { fk_view_id: 'v', redirect_url: 'javascript:alert(1)' } as any,
        ncMeta,
      ),
    ).rejects.toThrow(/Invalid redirect_url/);
    expect(ncMeta.metaInsert2).not.toHaveBeenCalled();
  });
});
