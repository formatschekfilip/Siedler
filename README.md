# Catan Game Tracker

A phone-friendly web app to log Settlers of Catan games (date, expansion, victory points per player) and show a leaderboard. Works on iPhone and Android in the browser, no app store needed.

**Current status: step 1 of 5.** Everything runs locally and saves on the device you use. Games are not shared between phones yet (see the roadmap below).

## Run it

**Option A: VS Code.** Install the "Live Server" extension, right-click `index.html`, choose "Open with Live Server".

**Option B: Python.** In this folder run `python3 -m http.server 8000` and open http://localhost:8000.

Click "Load sample games" on the empty leaderboard to see it with data.

To try it on your phone, connect it to the same Wi-Fi as your computer and open `http://<your-computer-ip>:8000` (use option B). The phone keeps its own separate data until step 3.

## Files

```
catan-tracker/
├── index.html   skeleton: an empty page, the bottom navigation, links to the other two files
├── style.css    looks: colors, spacing, dark mode, the round number tokens
├── app.js       brain: data, statistics, the three screens, saving and deleting
└── README.md    this file
```

HTML is the structure, CSS is the looks, JavaScript is the behavior. Almost all the work happens in `app.js`.

## How the app works

One loop drives everything:

1. The **state** (variables in `app.js`) holds the games, the current tab and the form fields.
2. `render()` turns the state into HTML text and puts it into `<div id="app">`.
3. Buttons call functions via `onclick="..."` attributes.
4. Those functions change the state, save it, and call `render()` again.

`app.js` is divided into numbered sections: Storage, Helpers, State, Statistics, Screens, Actions, Start. Each has a comment explaining it.

Saved data looks like this (statistics are never stored, they are calculated from this list):

```json
{ "games": [
  { "id": 1760000000000, "date": "2026-10-10", "expansion": "Seafarers", "notes": "",
    "results": [ { "name": "Anna", "vp": 10 }, { "name": "Ben", "vp": 7 } ] }
] }
```

## Python to JavaScript cheat sheet

| Python | JavaScript |
|---|---|
| `f"Hi {name}"` | `` `Hi ${name}` `` (backticks) |
| `[f(x) for x in xs]` | `xs.map(x => f(x))` |
| `[x for x in xs if x > 1]` | `xs.filter(x => x > 1)` |
| `"".join(parts)` | `parts.join("")` |
| `{"a": 1}` (dict) | `{ a: 1 }` (object) |
| `None` | `null` |
| `json.dumps` / `json.loads` | `JSON.stringify` / `JSON.parse` |
| `print(x)` | `console.log(x)` (shown in the browser console, F12) |
| `x = 1` | `let x = 1` (changeable) or `const x = 1` (fixed) |

Debugging tip: press F12 in the browser. The Console shows errors, and "Application > Local Storage" shows the saved games.

## Common changes

- **Add an expansion:** edit the `EXPS` list in `app.js`.
- **Change colors:** edit the variables at the top of `style.css`.
- **Allow fewer or more players:** search `app.js` for `6` and `3` in `addRow`, `rmRow` and `renderNew`.
- **Start fresh:** use "Erase all games" at the bottom of the History tab.

## Roadmap

**Step 2: database.** Create a free project at supabase.com and run this in its SQL editor:

```sql
create table players (
  id bigint generated always as identity primary key,
  name text not null unique
);
create table games (
  id bigint generated always as identity primary key,
  played_on date not null,
  expansion text not null,
  notes text,
  photo_path text            -- for board photos in step 5
);
create table results (
  game_id bigint not null references games(id) on delete cascade,
  player_id bigint not null references players(id),
  vp int not null check (vp between 0 and 30),
  primary key (game_id, player_id)
);
```

**Step 3: connect the app.** Replace `store.load()` and `store.save()` in `app.js` with Supabase calls (load all games, insert a game, delete a game). These become `async` functions, so the app waits for the data before the first `render()`. The screens and statistics stay unchanged. Note that the Supabase key ends up inside the page, so anyone with the link could write to the database. That is fine for a private group, and a shared password can be added later.

**Step 4: put it online.** Upload the folder to GitHub Pages, Netlify or Cloudflare Pages (all free) and send your friends the link.
- iPhone: open it in Safari, Share, Add to Home Screen.
- Android: open it in Chrome, menu, Install app.

**Step 5: board photos.** Add an `<input type="file" accept="image/*">` to the new-game form, upload the picture to a Supabase Storage bucket, and save its path in `games.photo_path`. Show it in the history cards.

Heads up: Supabase free projects pause after 7 days of inactivity. The data is kept and you restore the project from the dashboard.

## Known limitations of this version

- Data lives only on the device (until step 3).
- Games cannot be edited, only deleted and re-entered.
- If two players tie for the highest VP, both count as winners.
- No accounts or passwords.