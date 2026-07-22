"""
Generate seed SQL (teams + drivers) from the ATC roster spreadsheet.

Usage:
    python3 generate_seed.py /path/to/roster.xlsx

Produces, next to this script:
    seed_teams.sql
    seed_drivers.sql

Re-run this any time the roster spreadsheet is updated and re-apply the
generated SQL in the Supabase SQL editor (or via `supabase db execute`)
to sync the database.

Notes on source-data quirks handled here (flagged to the user separately):
  - The "Penalty Pts" column mixes two representations: plain strings like
    "0/11" or "1.5/11", and Excel-native datetimes. The datetimes are almost
    certainly Excel auto-formatting a typed value like "4/11" as April 11 —
    every recovered case has day == 11, matching the max used everywhere
    else. We recover (points, max) = (month, day) for those cells.
  - "N/A" and blank car values are both treated as NULL.
  - Car numbers that are blank in the sheet are inserted as NULL (a driver
    without an assigned number yet).
"""
import sys
import datetime
import re
import openpyxl

def parse_penalty(raw):
    if raw is None:
        return (0, 11)
    if isinstance(raw, datetime.datetime):
        return (raw.month, raw.day)
    if isinstance(raw, (int, float)):
        return (raw, 11)
    s = str(raw).strip()
    m = re.match(r'^([\d.]+)\s*/\s*(\d+)$', s)
    if m:
        pts = float(m.group(1))
        pts = int(pts) if pts.is_integer() else pts
        return (pts, int(m.group(2)))
    return (0, 11)

def sql_str(v):
    if v is None:
        return 'NULL'
    return "'" + str(v).replace("'", "''") + "'"

def sql_num(v):
    if v is None:
        return 'NULL'
    return str(v)

def sql_bool(v):
    return 'true' if v else 'false'

def main(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb['curr_roster']

    rows = []
    for row in ws.iter_rows(min_row=4, values_only=True):
        # A name in column C (index 2) marks a real data row
        if not row[2]:
            continue
        rows.append(row)

    teams = sorted({row[6] for row in rows if row[6]})

    with open('seed_teams.sql', 'w') as f:
        f.write('-- Auto-generated from roster spreadsheet. Safe to re-run.\n')
        f.write('insert into teams (name) values\n')
        f.write(',\n'.join(f'  ({sql_str(t)})' for t in teams))
        f.write('\non conflict (name) do nothing;\n')

    with open('seed_drivers.sql', 'w') as f:
        f.write('-- Auto-generated from roster spreadsheet. Safe to re-run (upserts on name).\n')
        f.write(
            'insert into drivers\n'
            '  (car_number, name, status_id, class_id, team_id, is_rookie, car,\n'
            '   appearances, starts, seasons_count, penalty_points, penalty_points_max)\n'
            'values\n'
        )
        lines = []
        flagged = []
        for row in rows:
            car_number, name, status, klass, penalty_raw, team, _, rookie, car, appearances, starts, seasons_count = row[1:13]
            pts, pts_max = parse_penalty(penalty_raw)
            if isinstance(penalty_raw, datetime.datetime):
                flagged.append((name, penalty_raw, pts, pts_max))
            car_val = None if (car is None or str(car).strip().upper() == 'N/A') else car
            team_subquery = (
                f"(select id from teams where name = {sql_str(team)})" if team else 'NULL'
            )
            status_subquery = f"(select id from driver_statuses where name = {sql_str(status)})"
            class_subquery = f"(select id from driver_classes where name = {sql_str(klass)})"
            lines.append(
                f"  ({sql_num(int(car_number) if car_number is not None else None)}, "
                f"{sql_str(name)}, {status_subquery}, {class_subquery}, {team_subquery}, "
                f"{sql_bool(rookie)}, {sql_str(car_val)}, "
                f"{sql_num(int(appearances) if appearances is not None else 0)}, "
                f"{sql_num(int(starts) if starts is not None else 0)}, "
                f"{sql_num(int(seasons_count) if seasons_count is not None else 0)}, "
                f"{sql_num(pts)}, {sql_num(pts_max)})"
            )
        f.write(',\n'.join(lines))
        f.write('\non conflict (name) do update set\n')
        f.write(
            '  car_number = excluded.car_number,\n'
            '  status_id = excluded.status_id,\n'
            '  class_id = excluded.class_id,\n'
            '  team_id = excluded.team_id,\n'
            '  is_rookie = excluded.is_rookie,\n'
            '  car = excluded.car,\n'
            '  appearances = excluded.appearances,\n'
            '  starts = excluded.starts,\n'
            '  seasons_count = excluded.seasons_count,\n'
            '  penalty_points = excluded.penalty_points,\n'
            '  penalty_points_max = excluded.penalty_points_max;\n'
        )

    print(f'{len(rows)} drivers, {len(teams)} teams written.')
    if flagged:
        print(f'\n{len(flagged)} rows had a datetime-corrupted Penalty Pts cell, recovered as (month/day):')
        for name, raw, pts, pts_max in flagged:
            print(f'  {name}: {raw.date()}  ->  recovered as {pts}/{pts_max}')

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'roster.xlsx')
