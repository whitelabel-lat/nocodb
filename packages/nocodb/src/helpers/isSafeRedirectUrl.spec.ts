import {
  isAbsoluteHttpRedirectUrl,
  isSafeRedirectUrl,
} from '~/helpers/isSafeRedirectUrl';

describe('isAbsoluteHttpRedirectUrl', () => {
  it.each([
    'http://example.com',
    'https://example.com/thanks?id={record_id}',
    '  https://example.com/path  ',
    'HTTPS://EXAMPLE.COM',
  ])('accepts %p', (url) => {
    expect(isAbsoluteHttpRedirectUrl(url)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://example.com',
    '/relative/path',
    '//evil.example.com',
    '\\\\evil.example.com',
    'example.com',
    'https://exa\tmple.com',
    '',
    '   ',
    null,
    undefined,
    42,
    {},
  ])('rejects %p', (url) => {
    expect(isAbsoluteHttpRedirectUrl(url)).toBe(false);
  });

  it('is stricter than isSafeRedirectUrl, which still allows relative URLs', () => {
    expect(isSafeRedirectUrl('/relative')).toBe(true);
    expect(isAbsoluteHttpRedirectUrl('/relative')).toBe(false);
  });
});
