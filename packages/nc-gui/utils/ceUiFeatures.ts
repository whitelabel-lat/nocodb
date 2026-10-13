/**
 * EE screens that this community build turns on one by one.
 *
 * `isEeUI` stays `false`: flipping it would also show EE screens whose backend is
 * not in the public repo. Enable a feature here only if its backend exists.
 * Use it as `isEeUI || ceUiFeatures.<name>` so upstream merges stay trivial.
 */
export const ceUiFeatures = {
  /** "Admin Panel" entry in the user menu (/admin). */
  adminPanel: true,
  /** Extensions panel in the topbar (`/api/v2/extensions`). */
  extensions: true,
  /** Hide the "Try NocoDB Cloud" upsell card in the sidebar footer. */
  hideJoinCloud: true,
} as const
