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
  /** "Remove member" in the workspace members list (`DELETE /api/v1/workspaces/:id/users/:userId`). */
  workspaceMemberRemove: true,
  /** Audit log screens: admin panel, workspace settings and base settings (`*AuditList` internal operations). */
  audit: true,
  /** Hide the "Try NocoDB Cloud" upsell card in the sidebar footer. */
  hideJoinCloud: true,
  /** "Hide field names" toggle on Gallery and Kanban cards (`meta.is_field_header_visible`, no backend needed). */
  cardFieldHeader: true,
  /** "Redirect to URL" after submitting a form (`redirect_url` stored by FormView, only absolute http(s) accepted). */
  formRedirect: true,
  /** Custom banner and logo upload plus "Hide NocoDB branding" on forms (`banner_image_url`, `logo_url`, `meta.hide_branding`). */
  formBranding: true,
  /** Switch filters, sorts and group-by on/off without deleting them (`enabled` column, honored by the backend). */
  viewToggles: true,
} as const
