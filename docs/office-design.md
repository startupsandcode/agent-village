# Village Office: local first design

## Purpose

Give a human a quick, honest view of the five Agent Village roles, their explicitly reported current focus, and the open GitHub issue queue. The office illustration makes the roles memorable; task text remains the primary source of meaning.

## First release

The site runs on `127.0.0.1:4173` on John's machine. This repository is private and its previous Vercel connection is inactive, so no private issue title or activity summary is published. A later shared deployment needs an explicit access decision and a server that keeps GitHub credentials private.

The page has five desk cards, one per agent, and a task board. A desk reports **Working** only when that agent has explicitly checked in and the report has not expired. Every active report shows its task, optional issue link, and time reported. Expired reports show **Last reported**, including the old time; absent reports show **No activity reported**. An open issue by itself never sets an agent's presence. The board lists actual open issues, fetched server side through the logged-in GitHub CLI. It has distinct empty and unavailable states.

## Data and update contract

`GET /api/office` returns `{ generatedAt, agents, tasks }`. Each agent has `name`, `role`, `status` (`working`, `stale`, `unknown`, or `unavailable` when its report cannot be read), `summary`, `issueNumber`, `updatedAt`, and `expiresAt`. `tasks` has `status` (`ok` or `error`), `updatedAt`, and `items` with issue number, title, URL, and update time. The browser polls every 30 seconds and offers manual refresh.

`node office/checkin.mjs start <agent> <summary> [issue-number]` records an explicit report locally with a 90-minute expiry. `node office/checkin.mjs finish <agent>` clears the current report. Each agent's file lives in `office/.local/checkins/`, is excluded from Git, and is never served directly. A report's expiry is a guard against false presence; agents refresh it when work continues. If the local site is not running, a check-in still writes the report for the next visit. The main Codex conversation remains accountable for these updates and specialist reports.

The local server binds only to loopback, requires a localhost Host header, reads the check-in files, and invokes `gh issue list` with fixed arguments. It never accepts arbitrary shell input or sends a GitHub token to the browser. Inputs and JSON are validated; browser text is rendered as text, not HTML. The server does not offer a remote write endpoint.

## Visual language

A drawn office floor plan is the signature: five distinctive desks arranged around a shared table, with a status tile beside each desk. Cool paper blue walls, deep ink, teal, coral, and sunflower accents echo a lively working studio. Headlines use a sturdy rounded system face; body copy stays compact and legible. On narrow screens, the desk cards become a single column and the task board follows immediately. Status uses words as well as color. Focus rings and reduced-motion settings remain visible.

## Verification

Exercise report start, expiry, finish, malformed input, GitHub queue success and failure, and local-only binding. Review desktop and mobile layouts in a browser. The README must explain the manual trigger and the difference between a reported focus and automatic live telemetry.
