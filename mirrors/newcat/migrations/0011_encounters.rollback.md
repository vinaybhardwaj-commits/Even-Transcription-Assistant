# 0011_encounters rollback note (not a .sql file: the migration runner ignores it)

Revert ONLY while both tables are empty. Run everything in one transaction: take the lock first, then re-check the counts, and abort if either is non-zero (a writer between a check and the drops would otherwise lose rows):

    begin;
    lock table encounters, encounter_links in access exclusive mode;
    select (select count(*) from encounter_links) as links, (select count(*) from encounters) as encounters;

If either count is non-zero, run `rollback;` and stop. If both are 0, continue in the same transaction:

    drop trigger encounter_links_no_update on encounter_links;
    drop trigger encounter_links_no_delete on encounter_links;
    drop trigger encounter_links_no_truncate on encounter_links;
    drop trigger encounters_no_update on encounters;
    drop trigger encounters_no_delete on encounters;
    drop trigger encounters_no_truncate on encounters;
    drop table encounter_links;
    drop table encounters;
    drop function encounter_append_only();
    delete from schema_migrations where id = '0011_encounters.sql';
    commit;

If ANY row exists, do NOT drop anything: leave the tables and triggers in place and stop writing to them (no hard deletes, ever; the triggers would refuse them anyway).

Grants: the migration only runs `revoke all on encounters, encounter_links from public`. No other role was granted anything, so there is nothing to revoke on rollback.
