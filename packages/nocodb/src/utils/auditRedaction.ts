// CE implementation (whitelabel fork)
const REDACTED = '[REDACTED]';

// Keys that carry credentials, whatever the audit event is. Column titles of
// user tables land here too (record audits key the cell values by title), so a
// column called "Password" is hidden as well.
const SENSITIVE_KEY =
  /pass(word|wd|phrase)?|secret|token|api[-_ ]?key|authorization|credential|private[-_ ]?key|bearer|cookie|otp|^signed(url|path)$/i;

const JWT = /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*/g;
const BEARER = /\bBearer\s+[\w.~+/=-]+/gi;
const SIGNED_QUERY =
  /([?&](?:token|signature|x-amz-signature|x-amz-credential|x-amz-security-token|sig)=)[^&\s"']+/gi;

export function redactAuditString(value: string): string {
  return value
    .replace(JWT, REDACTED)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(SIGNED_QUERY, `$1${REDACTED}`);
}

export function redactAuditValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactAuditString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 12) return REDACTED;
  if (Array.isArray(value)) {
    return value.map((v) => redactAuditValue(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'column_meta') {
      // only holds {id, title, type} per column; the UI needs it to label cells
      out[k] = v;
    } else if (SENSITIVE_KEY.test(k)) {
      out[k] = v === null || v === undefined || v === '' ? v : REDACTED;
    } else {
      out[k] = redactAuditValue(v, depth + 1);
    }
  }
  return out;
}

// Larger payloads (bulk edits) are not parsed or returned in a listing.
export const AUDIT_DETAILS_MAX_CHARS = 100_000;

/** Parse, redact and re-serialise the `details` column of an audit row. */
export function redactAuditDetails(details: unknown): string | null {
  if (details === null || details === undefined || details === '') return null;
  const raw = typeof details === 'string' ? details : JSON.stringify(details);
  if (raw.length > AUDIT_DETAILS_MAX_CHARS) {
    return JSON.stringify({ truncated: true, size: raw.length });
  }
  try {
    return JSON.stringify(redactAuditValue(JSON.parse(raw)));
  } catch {
    return redactAuditString(raw);
  }
}
