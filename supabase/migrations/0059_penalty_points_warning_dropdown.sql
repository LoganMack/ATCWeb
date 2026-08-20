-- The Incident Report dialog's "Penalty points (PP)" field and its separate
-- "This is a warning" checkbox (0014_penalties.sql's penalty_points column,
-- is_warning boolean) are being merged into one dropdown: Warning, or a
-- literal 1-7 PP award — see src/pages/results/[subsessionId]/incidents.astro.
-- The two underlying columns are UNCHANGED (still is_warning boolean +
-- penalty_points integer) — this migration only exists to make that pair
-- unambiguous everywhere going forward, since the two fields used to be
-- fully independent (an admin could check "warning" AND separately type a
-- nonzero PP value into the same incident) and the new dropdown can only
-- ever represent one OR the other at a time.
--
-- Every row read through the new dialog already maps correctly regardless
-- of this migration (is_warning wins outright when set, see the page's own
-- edit-handler comment) — this is a one-time cleanup so a WARNING row never
-- silently loses a nonzero penalty_points the next time someone opens and
-- re-saves it through the new dropdown (which always writes PP 0 for a
-- Warning pick). Values outside 0-7 or negative are left alone by this
-- statement — there's no evidence any exist, and if they do they're a
-- separate data problem this change doesn't need to paper over.
update public.penalties
set penalty_points = 0
where is_warning = true
  and penalty_points <> 0;
