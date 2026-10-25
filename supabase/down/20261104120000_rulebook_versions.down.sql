-- Undoes 20261104120000_rulebook_versions.sql: drops save_rulebook_version() and the rulebook_versions table
-- (its policy, grants and seeded row go with it).
--
-- Every saved rulebook version is lost. To keep them, first export the table in the SQL editor
-- (select * from public.rulebook_versions order by id, then download the result as CSV).

drop function public.save_rulebook_version(text, text, bigint);
drop table public.rulebook_versions;
