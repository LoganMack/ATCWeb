// Element ids on the incidents page, shared by its markup and the POST handlers that redirect to them.

// id of the Reported Incidents panel. Dismiss/Reopen and saving a review
// redirect to it, so the steward lands back on their review queue instead of
// the top of the page; the shell scrolls to it once the fragment is in.
export const REPORTS_ANCHOR = 'reported-incidents';
// ids the round-penalty forms redirect back to: the Round Penalties table, the Round Summary and
// the stewards' owed-penalties box.
export const ROUND_PENALTIES_ANCHOR = 'round-penalties';
export const ROUND_SUMMARY_ANCHOR = 'round-summary';
export const OWED_PENALTIES_ANCHOR = 'owed-penalties';
