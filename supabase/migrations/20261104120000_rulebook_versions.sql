-- Native rulebook (FR1, FR4.5, FR5).
--
-- What: a new table public.rulebook_versions holding the league rulebook as markdown plus a short version
-- label ("18.3"), with who saved it and when. Anyone may read it; nobody writes it directly. Admins save
-- through public.save_rulebook_version(), which checks the caller is an admin, refuses an empty label or
-- body, refuses a save made from a stale editor (someone else saved since it was opened), inserts the new
-- version and keeps only the 10 newest. Restoring an old version is the same call with that version's text.
-- The table is seeded with Rulebook 18.3, cleaned up from the Google Doc export.
--
-- Why in the database: the rulebook is public, but only admins may change it, so the write rule lives in a
-- definer function and Row Level Security rather than in page code. The 10-version trim and the stale-save
-- check run inside the same locked transaction as the insert, so two admins saving at once can't both win
-- or leave 11 rows.
--
-- Expand only: nothing existing changes; the code on main never reads this table. Undo with
-- supabase/down/20261104120000_rulebook_versions.down.sql.
--
-- save_rulebook_version raises '<CODE>: <message>' with errcode P0001 (src/lib/db/rulebook.ts reads the
-- prefix): NOT_ADMIN, INVALID (followed by 'version_label:' or 'body_md:') and STALE_VERSION.

-- 1. The versions (FR1.1, FR1.2). The primary key serves the public page's "latest row" read
--    (order by id desc limit 1), so no other index is needed for at most 10 rows.
create table public.rulebook_versions (
  id bigint generated always as identity primary key,
  version_label text not null check (char_length(version_label) between 1 and 40 and version_label ~ '\S'),
  body_md text not null check (char_length(body_md) between 1 and 200000 and body_md ~ '\S'),
  saved_at timestamptz not null default now(),
  saved_by uuid references public.profiles (id) on delete set null
);

comment on table public.rulebook_versions is
  'The league rulebook as markdown, newest id = current version; at most 10 rows. Written only by save_rulebook_version().';
comment on column public.rulebook_versions.saved_by is
  'The admin who saved this version; null for the seeded version or once that account is deleted.';

-- 2. Public read, no direct writes (FR1.4). New public tables get every privilege by default, so start from
--    nothing and grant select back.
alter table public.rulebook_versions enable row level security;

create policy "public read rulebook_versions" on public.rulebook_versions
  for select to anon, authenticated
  using (true);

revoke all on table public.rulebook_versions from public, anon, authenticated;
grant select on table public.rulebook_versions to anon, authenticated;

-- 3. The only write path (FR1.2-FR1.4, FR4.3, FR4.5). p_expected_latest_id is the newest id the editor was
--    opened on (null when there was none); any other current newest id means someone saved in between.
create function public.save_rulebook_version(
  p_version_label text,
  p_body_md text,
  p_expected_latest_id bigint
) returns bigint
  language plpgsql security definer
  set search_path = ''
  as $$
declare
  v_label text := btrim(coalesce(p_version_label, ''));
  v_latest bigint;
  v_id bigint;
begin
  if not coalesce(private.is_admin(), false) then
    raise exception 'NOT_ADMIN: Only admins can save the rulebook' using errcode = 'P0001';
  end if;
  if v_label = '' or char_length(v_label) > 40 then
    raise exception 'INVALID: version_label: Enter a version label of 1 to 40 characters' using errcode = 'P0001';
  end if;
  if p_body_md is null or p_body_md !~ '\S' or char_length(p_body_md) > 200000 then
    raise exception 'INVALID: body_md: Enter the rulebook text (at most 200,000 characters)' using errcode = 'P0001';
  end if;

  -- Self-conflicting lock: concurrent saves take turns, while plain reads are never blocked.
  lock table public.rulebook_versions in share row exclusive mode;

  select max(id) into v_latest from public.rulebook_versions;
  if v_latest is distinct from p_expected_latest_id then
    raise exception 'STALE_VERSION: Someone saved the rulebook after you opened it' using errcode = 'P0001';
  end if;

  insert into public.rulebook_versions (version_label, body_md, saved_by)
  values (v_label, p_body_md, (select auth.uid()))
  returning id into v_id;

  delete from public.rulebook_versions
  where id not in (select r.id from public.rulebook_versions r order by r.id desc limit 10);

  return v_id;
end;
$$;

revoke all on function public.save_rulebook_version(text, text, bigint) from public, anon;
grant execute on function public.save_rulebook_version(text, text, bigint) to authenticated;

-- 4. The first version (FR1.5, FR5): Rulebook 18.3 from the Google Doc's markdown export, with heading and
--    table-cell italics removed, section headings as plain headings and squashed table cells split. Every
--    section and rule number is unchanged; the legend line and the logo are left out.
insert into public.rulebook_versions (version_label, body_md) values ('18.3', $rulebook$## 1. Community Guidelines

1. Display good sportsmanship, on and off the track.
2. Maintain a respectful environment. Any form of toxicity is not tolerated.
3. Refrain from political or religious discussions. Liveries with political or religious themes are not permitted.
4. Vehicle liveries must also adhere to iRacing's terms of service and should not contain any nudity, gore, etc.
5. Adhere to the rules defined in the iRacing Sporting Code in addition to any described in this document.
6. iRacing chat should primarily be used for important in-race communications.

## 2. Driver’s Championship

1. Drivers are allowed 1 free mid-season car swap. Subsequent swaps will result in a pit lane start penalty.
2. If a new car is introduced mid-season, an additional free car swap will be provided.
3. Setups are open.
4. After making 3 appearances in a single season, drivers lose rookie status.
5. There is no minimum iRating, but drivers who demonstrate extraordinarily slow pace relative to the field may be asked to practice more before continuing to race in the series.

### Class System

6. There are three Driver Championships, Alpha (pro), Gamma (pro-am) and Delta (am).
7. All championships share the same base points system.
8. Delta and gamma drivers can earn extra delta or gamma points by finishing on their class podium.
9. Drivers are entered into the delta class if their iRating is less than 2,500 at the start of their first season.
10. Drivers are entered into the gamma class if their iRating is less than 4,500 at the start of their first season.
11. When a driver transfers class mid-season, they carry over all regular points. The following are not retroactive:
    1. Delta and Gamma podium points.
    2. Delta team points.
    3. Delta statistics. *(wins, podiums, etc.)*

### Promotion/Demotion

12. Promotion is always required, demotion is always optional.
13. Mid-season class changes must be done prior to round 4.
14. Drivers are promoted from the delta or gamma class in the following scenarios:
    1. Driver has won the most recent delta or gamma championship.
    2. Driver demonstrates significantly different pace from their current class in their rookie season.
15. Drivers may request a demotion from the alpha or gamma class in the following scenarios:
    1. Driver appears in a minimum 2/3 of races during at least two out of the previous three seasons.
    2. Driver demonstrates significantly worse pace from their current class.
    3. Driver would not have won their target classes’ championship within the past three seasons.

### Driver Numbering

16. If a driver has not appeared in a race within the past 90 days, their number will become available.
17. Drivers are exempt from forfeiting their number in the following scenarios:
    1. Driver has made at least 75 career appearances.
    2. Driver has won at least 1 alpha championship.
    3. Driver is in the Hall of Fame.
18. Inactive drivers will be assigned a default unused number in the #900s.
19. Leading zeroes do not distinguish numbers. #04 and #4 are considered the same number.
20. The #1 is reserved for the current overall champion.

### Drop Weeks

21. Each season, drivers will drop their 2 lowest-scoring rounds.
22. Rounds where a driver is disqualified due to a penalty cannot be dropped.
23. Drop weeks do not apply to team points.
24. Stewards may add a maximum of 1 drop week to the season under the follow scenarios:
    1. If servers fail and multiple drivers are disconnected from a session.
    2. If the grid limit is reached and multiple drivers are unable to join a full session.

### Scoring Rules

25. Drivers are classified first by completed laps, then by total race time. Drivers that finish less than 50% of race length are not classified, and score no points. Unless penalized, drivers who finish outside the points but above the >50% threshold earn minimum points.
26. Bonuses are available on a per race basis for 2 achievements:
    1. Collecting less than 4 incident points.
    2. Class pole position.

### Table: Points System

| Pos | Endurance | Sprint |
| :---: | :---: | :---: |
| **1** | 200 | 100 |
| **2** | 190 | 95 |
| **3** | 180 | 90 |
| **4** | 170 | 85 |
| **5** | 162 | 81 |
| **6** | 154 | 77 |
| **7** | 146 | 73 |
| **8** | 138 | 69 |
| **9** | 130 | 65 |
| **10** | 122 | 61 |
| **11** | 114 | 57 |
| **12** | 108 | 54 |
| **13** | 102 | 51 |
| **14** | 96 | 48 |
| **15** | 90 | 45 |
| **16** | 84 | 42 |
| **17** | 78 | 39 |
| **18** | 72 | 36 |
| **19** | 66 | 33 |
| **20** | 60 | 30 |
| **21** | 54 | 27 |
| **22** | 50 | 25 |
| **23** | 46 | 23 |
| **24** | 42 | 21 |
| **25** | 38 | 19 |
| **26** | 34 | 17 |
| **27** | 32 | 16 |
| **28** | 30 | 15 |
| **29** | 28 | 14 |
| **30** | 26 | 13 |
| **31** | 24 | 12 |
| **32** | 22 | 11 |
| **33** | 20 | 10 |
| **34** | 18 | 9 |
| **35** | 16 | 8 |
| **36** | 14 | 7 |
| **37** | 12 | 6 |
| **38** | 10 | 5 |
| **39** | 8 | 4 |
| **40** | 6 | 3 |
| **Classified** | 6 | 3 |

### Table: Class Points

| Pos | Endurance | Sprint |
| :---: | :---: | :---: |
| **1** | 8 | 4 |
| **2** | 4 | 2 |
| **3** | 2 | 1 |

### Table: Bonus Points

| Type | Description | Endurance | Sprint |
| :---: | --- | :---: | :---: |
| **Sublime Finesse** | 3x or less in 1 race. Must be classified. | 4 | 2 |
| **Class Pole** | Finish 1st in class in qualifying. | 4 | 4 |

## 3. Team Championship

1. There are two team championships, Alpha *(pro, pro-am)* and Delta *(am)*.
2. Each team’s 2 highest-scoring delta drivers per race count towards the delta team championship.
3. Each team’s 2 highest-scoring drivers per race count towards the alpha team championship.
4. Delta class podium bonus points also count towards the delta team championship.
5. Gamma class podium bonus points do not count towards any team championship.
6. Teams may roster up to 3 drivers.
7. Team orders, such as position swapping, are permitted as long as they are executed safely.
8. Defending is allowed, dangerously slowing to aid a teammate is not. Rules on blue flags and blocking still apply.
9. Teams formed or drivers signed after round 2 cannot earn team points retroactively.

## 4. Race Day Format

### Session Timing

1. Races take place on Mondays.
2. Qualifying sessions begin at 9:30 PM US eastern time.
3. Race sessions begin at 9:40 PM US eastern time.

### Qualifying

4. Qualifying for all rounds is solo, 10 minutes and 2 laps long.
5. Special events may feature unique qualifying formats.

### Race Sessions

6. Rounds will have an incident limit of 15x. After 30x, drivers are disqualified.
7. The incident limit may be adjusted if needed for special events.
8. Endurance rounds require the change of at least 1 tire at some point during the race, regardless of weather.
9. Failing to make the mandatory tire change results in a +1 lap penalty. This is enforced by removing 1 lap from the driver’s total, and then placing them last amongst the drivers who finished on that lap.

## 5. Stewarding

### Incident Reviews

1. After each round, an incident report will be published detailing all incident decisions by the stewards.
2. Stewards involved in an incident must recuse themselves from ruling on or commenting on that incident.
3. If a steward is involved in an incident under appeal, they will not have access to the appeal.
4. Steward decisions are made by simple majority vote unless specified otherwise.

### Appeals

5. Drivers have the right to appeal any penalty. Must be submitted within 24 hours of the report being posted.
6. Appeals are expected to include new evidence that the stewards originally would not have had access to.

### Penalty Points

7. Each driver has an 11 penalty point *(PP)* limit for the season. Drivers who reach this limit serve a 1 round ban.
8. If the limit is met during the final round, the driver will receive a DSQ instead.
9. After a driver reaches the limit, their *PP* resets to 0 and they will enter probation.
10. Earned *PP* are doubled during probationary periods.
11. Probation lasts for either 4 rounds or 45 days, whichever is longer.
12. If a driver reaches the *PP* limit again during their probation, they will receive an 10 round ban.

### Penalty Guidelines

13. Drivers may be held responsible for incidents where they are deemed at fault, even in situations where they lost control of their car prior to any contact.
14. When a driver receives a time penalty, it is added to their total race time. If the added penalty places the driver more than a full lap behind the leader — measured by the leader's final lap pace — the driver is scored +1 lap down. The driver is then classified on that lap and ranked by its total race time.
15. Penalties incurred during the final round may be adjusted to apply to the current season and not the next.
16. Penalties are applied to the results of the race they occurred in. DSQs are applied to the entire round.
17. Netcode contact will be ruled as a racing incident unless it can be argued it would have occurred regardless.
18. Black flags received on the final lap induce a +35s penalty. Stewards may mitigate this based on track layout.
19. Drivers are allowed to receive net negative points after post-race penalties.
20. Negative points do not count against team points.
21. Unsportsmanlike conduct penalties are reserved for more severe, unique offenses that either attempt to undermine the rules and mechanics of the sim in a way unforeseen by the stewards or show blatant disregard for other drivers.
22. Stewards use the *Post-Race Penalties Table* as a guideline, and may adjust punishments to better suit incidents in outlier situations.

### Table: Post-Race Penalties

| Offense | Potential penalties |
| --- | --- |
| At fault for incident | +1 Warning or +1-4 *PP* |
| Lap 1 incident | +1 *PP* |
| At fault while in dangerous condition | +1 *PP* |
| At fault under blue flags *(see 6.15)* | +1 *PP* |
| Unsafe rejoin/no brakes held *(see 6.10)* | +1 Warning or +1 *PP* |
| Blocking *(see 6.13)* | +1 Warning or +1 *PP* |
| Impeding under blue flags *(see 6.15)* | +1 Warning or +1 *PP* |
| Unfair advantage gained *(see 6.14)* | +1 Warning or +1 *PP* |
| At fault for contact in post-race cooldown | +1 Warning and victim’s original incident count is restored |
| Voice and/or text chat abuse | +1 Warning or +1 *PP* and chat ban |
| 2 warnings | +1 *PP* |
| Unsportsmanlike conduct *(see 6.14)* | +1 Warning or +1-8 *PP* or DSQ |
| Failure to serve penalty correctly | +1 Warning or +1-8 *PP* or DSQ |
| Deliberate wrecking or retaliation | All punishments available |

### Table: PP Penalties

| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8+ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| +5s | +10s | +20s | +40s, qualy ban | +1 lap, pit start, -10 pts | +1 lap, pit start, -50 pts | +1 lap, race ban, -100 pts | Review |

## 6. Racing Guidelines

### Side-by-Side Racing

1. When side-by-side through a corner, the inside car must leave the outside car enough space to keep two tires completely on the racing surface where there is paved runoff, or four tires without paved runoff.
2. The racing surface is defined as the paved surface inside of and including the white lines, and any curbing next to it where you do not incur an off-track by going onto the curbing.
3. If the inside car leaves enough room on exit *(see 6.1)*, it becomes the outside car’s responsibility to stay on the racing surface. If they leave the racing surface as defined above without being forced off, the inside car is not required to let them back on track. The outside car is responsible for rejoining safely and without gaining an unfair advantage.

### Significant Overlap

4. Any 2 cars are considered side-by-side where there is significant overlap. Significant overlap is achieved when the trailing car’s front tires have any kind of overlap with the leading car’s rear tires before the leading car has begun to turn in towards the apex.
5. Significant overlap can be achieved after turn-in, but only if the move meets most of the following guidelines:
    1. The leading driver has left enough space for a clean overtake.
    2. The trailing driver has safely established themselves in that space without going off-track.
    3. If on the inside, the trailing driver makes the apex without understeering into the leading car.
    4. The leading driver has enough time to recognize that the trailing car has placed themselves there.
6. If on a straight, the guidelines adjust:
    1. Straights are defined as any straight or gentle curve that is always navigated at full throttle.
    2. With any overlap achieved, each car has a right to not be forced off the track.
    3. With significant overlap achieved *(see 6.5)* each car may hold their lane and not be forced left or right.
7. If the trailing car has achieved significant overlap, they retain it until the other car has completely cleared them. If there is still any overlap, the leading car is responsible for clearing the trailing car without forcing them off-track.
8. In situations with 3+ cars significant overlap rules still apply. If an incident occurs, stewards may still penalize drivers for creating dangerous 3+ wide situations despite having significant overlap with at least 1 car in the group.

### Rejoins & Lost Control

9. If a car leaves the track, it is their responsibility to rejoin safely.
10. Off-track cars must yield to cars on the edge of the track that are preventing them from rejoining.
11. If a driver has fully lost control of their car, they are expected to hold their brakes in all situations.
12. Drivers are held accountable for any incidents a loss of control causes.

### Unfair Advantage

13. Drivers may gain an unfair advantage via any of the following actions, including any unforeseen action not on this list but deemed extraordinarily unfair by the stewards.
    1. Cutting the course and gaining a lasting advantage.
    2. Forcing a driver completely off-track during an overtake attempt.
    3. At fault for contact that leads to another driver taking a slowdown penalty.
    4. Shunting a competitor out of the way to complete an overtake.
    5. Starting from pit lane incorrectly and exiting ahead of other cars.
    6. Using exploits to drive faster than the pit limiter allows on pit lane.
14. Drivers may neutralize an unfair advantage only if the time loss to the disadvantaged was minimal and they safely cede the position back within the next few corners.

### Blue Flags

15. This series considers the blue flag to be instructional, not just informational.
    1. Drivers passing a lapped car under blue flags are primarily responsible for making a clean pass.
    2. When under blue flags *(lead lap car within 1.5s)*, drivers are to avoid impeding the lead lap car.
    3. Impeding is defined as being directly responsible for an approximate time-loss of at least +0.5s.
16. The stewards’ recommendation for serving blue flags safely and with minimum time loss is to wait for a straight and move off the racing line prior to the next corner, let the lead lap car through, then rejoin the racing line behind the lead lap car before corner entry if room is available.

### Blocking

17. On the subject of blocking, per the iRacing Sporting Code: The leading driver is allowed to run a defensive line. However, blocking occurs when a leading driver actively adjusts his or her driving line based on the actions and/or positioning of a pursuing driver. For example, veering left to prevent a pursuing driver from passing on the left while running on a straight.
18. Weaving to break the tow is allowed. If the driver behind is considered close enough to attempt an overtake, generally 1-2 car lengths, weaving may be considered blocking.
19. Once braking for a corner, drivers are considered to have ‘committed’ to the racing lane they are currently on. Changing lanes at the expense of other drivers may be penalized, even if previously pointed at an angle across the track before braking.

### Slowdown Penalties

20. Drivers are responsible for serving slowdowns as safely as possible.
21. Serving a slowdown by driving slowly on the racing line while in front of others will be considered blocking.
22. Drivers serving a slowdown on a straight should pull completely off the racing line to do so if possible.
$rulebook$);
