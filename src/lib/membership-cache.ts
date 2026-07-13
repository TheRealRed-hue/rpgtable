/**
 * In-memory (per browser tab, per page-load) set of campaign IDs the current
 * user is already known to be a member of.
 *
 * Without this, `ensureCampaignMembership` (called from the campaign route's
 * `loader`) ran on every navigation to a campaign AND on every preload —
 * i.e. every time the user hovered a campaign card — each time doing a
 * network auth check plus an INSERT attempt. For an existing member that
 * insert always fails on the unique constraint and gets swallowed, so it
 * was pure repeated overhead and a contributor to hitting Supabase's rate
 * limit (429). Once we've confirmed membership once this session, skip it.
 *
 * Deliberately module-level (not React state): it needs to survive across
 * route loader calls that happen outside any component's lifecycle, and
 * resetting on full page reload is fine — that's a legitimate "recheck".
 */
const confirmedMemberships = new Set<string>();

export function isMembershipConfirmed(campaignId: string): boolean {
  return confirmedMemberships.has(campaignId);
}

export function markMembershipConfirmed(campaignId: string): void {
  confirmedMemberships.add(campaignId);
}
