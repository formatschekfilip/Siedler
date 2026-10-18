/*
 * app.js - the "brain" of the Catan tracker.
 *
 * HOW IT WORKS (one loop drives everything)
 *   1. STATE variables hold the data (games, current tab, form fields).
 *   2. render() builds HTML text from the state and puts it into <div id="app"> (see index.html).
 *   3. Buttons call functions through onclick="..." attributes in that HTML.
 *   4. Those functions change the state, save it, and call render() again.
 *
 * File layout: 1 Storage, 2 Helpers, 3 State, 4 Statistics, 5 Screens, 6 Actions, 7 Start.
 *
 * Needs: the Supabase library + config.js (URL and publishable key), both loaded in index.html BEFORE this file.
 * Python -> JavaScript cheat sheet is in README.md.
 */

/* ============================================================
   1. DATABASE - the only place that knows WHERE data lives
   ============================================================
   Games live in Supabase (Postgres): tables players, games, results.
   The page talks to it with the PUBLIC key from config.js. Row Level Security
   (the policies you created) decides what that key may do.
   `await` pauses a function until the network answers, like asyncio in Python;
   every function that uses await must be marked `async`.
   Troubleshooting (F12 > Console): empty list = missing "select" policy,
   "violates row-level security" = missing "insert" or "delete" policy. */
const { createClient } = supabase;   // `supabase` is provided by the script tag in index.html
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// Supabase answers with { data, error }. This throws on error so one try/catch can handle it.
function check(res) { if (res.error) throw res.error; return res.data; }

// Loads all games with their results and player names in ONE request, then converts them
// to the shape the screens and stats() already use: { id, date, expansion, notes, photo, results: [{name, vp}] }.
async function loadGames() {
  const rows = check(await db.from('games')
    .select('id, played_on, expansion, notes, photo_path, results(vp, players(name))'));
  return rows.map(g => ({
    id: g.id, date: g.played_on, expansion: g.expansion, notes: g.notes || '', photo: g.photo_path || null,
    results: g.results.map(r => ({ name: r.players.name, vp: r.vp })).sort((a, b) => b.vp - a.vp)
  }));
}

// Makes sure every name exists in the players table and returns { name: id }.
async function playerIds(wanted) {
  let players = check(await db.from('players').select('id, name'));
  const missing = wanted.filter(n => !players.some(p => p.name === n));
  if (missing.length) {
    check(await db.from('players').insert(missing.map(name => ({ name }))));
    players = check(await db.from('players').select('id, name'));
  }
  return Object.fromEntries(players.map(p => [p.name, p.id]));
}
// Turns [{name, vp}] into rows for the results table.
const resultRows = (gameId, results, ids) => results.map(r => ({ game_id: gameId, player_id: ids[r.name], vp: r.vp }));

// A game touches three tables: new names go into players, then games, then results.
async function addGame(game) {
  const ids = await playerIds(game.results.map(r => r.name));
  const g = check(await db.from('games')
    .insert({ played_on: game.date, expansion: game.expansion, notes: game.notes, photo_path: game.photo })
    .select().single());
  const res = await db.from('results').insert(resultRows(g.id, game.results, ids));
  if (res.error) {                       // undo the half-saved game
    await db.from('games').delete().eq('id', g.id);
    throw res.error;
  }
}

// Editing = update the game row, then replace its results (delete + insert).
// `old` is the previous version, used to put the old results back if the insert fails.
// Needs an UPDATE policy on the games table (see README). Without it Supabase changes
// 0 rows and reports no error, so we check how many rows came back.
async function updateGame(id, game, old) {
  const ids = await playerIds([...game.results, ...old.results].map(r => r.name));
  const upd = check(await db.from('games')
    .update({ played_on: game.date, expansion: game.expansion, notes: game.notes, photo_path: game.photo })
    .eq('id', id).select());
  if (!upd.length) throw new Error('Editing is not allowed yet (missing update policy in Supabase)');
  check(await db.from('results').delete().eq('game_id', id));
  const res = await db.from('results').insert(resultRows(id, game.results, ids));
  if (res.error) {
    await db.from('results').insert(resultRows(id, old.results, ids));
    throw res.error;
  }
}

// ---- Photos: stored as files in the Supabase Storage bucket below; the games table only keeps the file name ----
const BUCKET = 'board-photos';

// Phone photos are 3-10 MB. Shrink to max 1600 px as JPEG (about 300 KB) before uploading:
// the page uses the browser's canvas (a drawing surface) to redraw the image smaller.
async function shrinkImage(file, max = 1600) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }   // respects the phone's rotation
  catch (e) { bmp = await createImageBitmap(file); }
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((ok, fail) => c.toBlob(b => b ? ok(b) : fail(new Error('Could not process the image')), 'image/jpeg', 0.82));
}
// Uploads under a unique name (so nothing is ever overwritten) and returns that name.
async function uploadPhoto(blob) {
  const path = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jpg';
  const { error } = await db.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
  if (error) throw error;
  return path;
}
// Best effort: a leftover file is harmless, so failures are only logged.
async function removePhotos(paths) {
  paths = paths.filter(Boolean);
  if (!paths.length) return;
  const { error } = await db.storage.from(BUCKET).remove(paths);
  if (error) console.warn('Could not remove photo files', error);
}
const photoUrl = path => db.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

// Results are removed automatically (the table has "on delete cascade").
async function deleteGame(id) { check(await db.from('games').delete().eq('id', id)); }
async function deleteAll()    { check(await db.from('games').delete().gt('id', 0)); }

/* ============================================================
   2. HELPERS - small utilities used everywhere
   ============================================================ */
// Choices in the expansion dropdown. Add or rename entries here; saved games keep the text they were saved with.
const EXPS = ['Base game', 'Seafarers', 'Cities & Knights', 'Traders & Barbarians', 'Explorers & Pirates', 'Seafarers + Cities & Knights', 'Other'];
const $ = id => document.getElementById(id);
// Escapes < > & quotes so a player name can never break the page. Wrap ALL user text in esc() before putting it into HTML.
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Date -> 'YYYY-MM-DD' in local time. (toISOString() uses UTC and can be a day off.) This format also sorts correctly as plain text.
const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const today = () => ymd(new Date());
const fmt = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); };
const blankRows = () => [0, 1, 2, 3].map(() => ({ name: '', vp: '' }));
// All player names used so far, without duplicates (a Set works like Python's set). Feeds the name suggestions.
const names = () => [...new Set(data.games.flatMap(g => g.results.map(r => r.name)))];
// If you type 'anna' and 'Anna' exists, reuse 'Anna', so the stats don't split into two players.
const canon = n => names().find(x => x.toLowerCase() === n.toLowerCase()) || n;
// Small message that fades in at the bottom for 2 seconds.
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2000); }

/* ============================================================
   3. STATE - the variables that describe the app right now
   ============================================================
   data      = the games last loaded from the database: { games: [...] }
   saving    = true while a game is being saved (ignores double taps)
   editingId = id of the game being edited, or null when adding a new game
   photoView = URL of the photo shown full screen, or ''
   expFilter = 'all' or an expansion name; Leaderboard and History both show only matching games
   The rest only lives on screen and is lost on reload: current tab, sort mode,
   the new-game form (rows + draft), the last error and which delete button is armed.

   NOTE: the form variable is called `draft`, not `form`, on purpose. Inline handlers such as
   onchange="draft.exp=..." look at the element first, and every input/select already has a
   built-in property called `form` (its parent <form>), which would hide our variable. */
let data = { games: [] }, tab = 'board', sortBy = 'wins', saving = false;
// photoFile = newly chosen (already shrunk) image, photoPreview = temporary URL to show it,
// photoPath = file name of the photo already saved with the game (when editing).
const freshDraft = () => ({ date: today(), exp: EXPS[0], notes: '', photoFile: null, photoPreview: '', photoPath: '' });
let rows = blankRows(), draft = freshDraft(), formErr = '', armed = null, editingId = null, expFilter = 'all', photoView = '';

/* ============================================================
   4. STATISTICS - calculated from the game list every time, never stored
   ============================================================
   Fixing a typo in one game therefore corrects the whole leaderboard. */
// Games matching the expansion filter ('all' = everything). Leaderboard and History both use this.
const filtered = () => expFilter === 'all' ? data.games : data.games.filter(g => g.expansion === expFilter);
// Expansions that occur in saved games (dropdown order first, unknown ones after), for the filter dropdown.
const usedExps = () => { const u = new Set(data.games.map(g => g.expansion)); return [...EXPS.filter(e => u.has(e)), ...[...u].filter(e => !EXPS.includes(e))]; };
// One entry per player (counting only the filtered games): games, wins, VP total, win rate, average VP.
// A win = having the highest VP in a game (if two players tie, both count).
function stats() {
  const m = {};
  filtered().forEach(g => {
    const top = Math.max(...g.results.map(r => r.vp));
    g.results.forEach(r => {
      const s = m[r.name] ??= { name: r.name, games: 0, wins: 0, vp: 0 };
      s.games++; s.vp += r.vp; if (r.vp === top) s.wins++;
    });
  });
  return Object.values(m).map(s => ({ ...s, rate: s.wins / s.games, avg: s.vp / s.games }));
}
// How each sort button orders players. A negative result puts a first, like key= in Python's sorted().
// '||' is a tie-breaker: use the next rule when the first difference is 0.
const sorters = {
  wins: (a, b) => b.wins - a.wins || b.rate - a.rate || b.games - a.games,
  rate: (a, b) => b.rate - a.rate || b.games - a.games,
  avg: (a, b) => b.avg - a.avg
};
// The big number on the right of each player card, per sort mode: [value, label].
const shown = {
  wins: p => [p.wins, 'wins'],
  rate: p => [Math.round(p.rate * 100) + '%', 'win rate'],
  avg: p => [p.avg.toFixed(1), 'avg VP']
};

/* ============================================================
   5. SCREENS - each function returns the HTML for one screen
   ============================================================
   Template strings (backticks) with ${...} work like Python f-strings.
   list.map(x => ...).join('') is like ''.join([... for x in list]). */
// Shown on Leaderboard and History while there are no games.
function emptyCard() {
  return `<div class="card empty"><div class="tok hot big">0</div><h2>No games yet</h2>
  <p>Log your first game to see the leaderboard.</p>
  <button class="btn" onclick="go('new')">Add first game</button></div>`;
}

// Shown when a filter matches no games.
const noMatch = () => '<div class="card empty"><p>No games with this expansion yet.</p></div>';

// Dropdown at the top of Leaderboard and History. Changing it redraws with the filtered games.
function filterBar() {
  const list = ['all', ...usedExps()];
  if (!list.includes(expFilter)) list.push(expFilter);
  const opts = list.map(e => `<option value="${esc(e)}" ${e === expFilter ? 'selected' : ''}>${e === 'all' ? 'All expansions' : esc(e)}</option>`).join('');
  return `<label class="filter">Show<select class="in" onchange="expFilter=this.value;render()">${opts}</select></label>`;
}

// Screen 1: the leaderboard.
function renderBoard() {
  if (!data.games.length) return emptyCard();
  const games = filtered(), s = stats();
  if (!s.length) return filterBar() + noMatch();
  s.sort(sorters[sortBy]);
  const last = [...games].sort((a, b) => b.date.localeCompare(a.date))[0].date;
  const chips = [['wins', 'Wins'], ['rate', 'Win %'], ['avg', 'Avg VP']]
    .map(([k, l]) => `<button class="chip ${sortBy === k ? 'on' : ''}" onclick="sortBy='${k}';render()">${l}</button>`).join('');
  const list = s.map((p, i) => {
    const [v, label] = shown[sortBy](p);
    return `<div class="card player"><div class="tok ${i === 0 ? 'hot' : ''}">${i + 1}</div>
    <div class="grow"><div class="name">${esc(p.name)}</div><div class="sub">${p.wins} of ${p.games} games won, avg ${p.avg.toFixed(1)} VP</div></div>
    <div class="metric"><b>${v}</b><span>${label}</span></div></div>`;
  }).join('');
  const what = expFilter === 'all' ? 'logged' : 'of ' + esc(expFilter);
  return `<p class="lead">${games.length} ${games.length === 1 ? 'game' : 'games'} ${what}, latest on ${fmt(last)}</p>
  ${filterBar()}<div class="chips">${chips}</div>${list}`;
}

// Screen 2: new-game form. The same form is used for editing (editingId is set then). The oninput/onchange attributes copy what you type into `rows` and `draft`
// immediately, so re-rendering never loses your input.
function renderNew() {
  const dl = `<datalist id="names">${names().map(n => `<option value="${esc(n)}">`).join('')}</datalist>`;
  const rs = rows.map((r, i) => `<div class="prow">
    <input class="in grow" list="names" placeholder="Player ${i + 1}" autocomplete="off" value="${esc(r.name)}" oninput="rows[${i}].name=this.value">
    <input class="in vp" type="number" inputmode="numeric" min="0" max="30" placeholder="VP" value="${esc(r.vp)}" oninput="rows[${i}].vp=this.value">
    <button class="x" aria-label="Remove player ${i + 1}" onclick="rmRow(${i})" ${rows.length <= 3 ? 'disabled' : ''}>✕</button></div>`).join('');
  // Shows the new photo, else the one saved with the game. Both are optional.
  const pv = draft.photoFile ? draft.photoPreview : (draft.photoPath ? photoUrl(draft.photoPath) : '');
  const photoCard = `<div class="card"><h2>Photo of the finished board (optional)</h2>
    ${pv ? `<img class="photo" src="${esc(pv)}" alt="Selected board photo" style="cursor:default">` : ''}
    <input type="file" id="photoInput" accept="image/*" hidden onchange="pickPhoto(this)">
    <div class="prow" style="margin:10px 0 0"><button class="btn ghost" onclick="$('photoInput').click()">${pv ? 'Change photo' : 'Add photo'}</button>
    ${pv ? '<button class="btn ghost" onclick="removePhoto()">Remove</button>' : ''}</div></div>`;
  const choices = EXPS.includes(draft.exp) ? EXPS : [...EXPS, draft.exp];   // keeps unusual old values selectable
  const opts = choices.map(e => `<option ${e === draft.exp ? 'selected' : ''}>${esc(e)}</option>`).join('');
  return `<div class="card">
    <label>Date<input class="in" type="date" value="${draft.date}" onchange="draft.date=this.value"></label>
    <label style="margin:0">Expansion<select class="in" onchange="draft.exp=this.value">${opts}</select></label></div>
  <div class="card"><h2>Players and victory points</h2>${dl}${rs}
    <button class="btn ghost" onclick="addRow()" ${rows.length >= 6 ? 'disabled' : ''}>Add player</button></div>
  <div class="card"><label style="margin:0">Notes (optional)
    <textarea class="in" rows="2" placeholder="House rules, longest road drama, …" oninput="draft.notes=this.value">${esc(draft.notes)}</textarea></label>
    </div>
  ${photoCard}
  ${formErr ? `<div class="err">${esc(formErr)}</div>` : ''}
  <button class="btn full" onclick="saveGame()" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : editingId ? 'Save changes' : 'Save game'}</button>
  ${editingId ? '<button class="btn ghost full" style="margin-top:10px" onclick="cancelEdit()">Cancel</button>' : ''}`;
}

// Screen 3: games (filtered), newest first. Deleting needs two taps to prevent accidents.
function renderHistory() {
  if (!data.games.length) return emptyCard();
  const games = filtered();
  if (!games.length) return filterBar() + noMatch();
  const g = [...games].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  const cards = g.map(x => {
    const top = Math.max(...x.results.map(r => r.vp));
    const res = x.results.map(r => `<div class="res ${r.vp === top ? 'win' : ''}">
      <span class="n">${esc(r.name)}</span><div class="bar"><i style="width:${Math.min(100, r.vp * 10)}%"></i></div>
      <span class="tok sm">${r.vp}</span></div>`).join('');
    return `<div class="card"><div class="gh"><div><b>${fmt(x.date)}</b><span class="tag">${esc(x.expansion)}</span></div>
      <div class="acts"><button class="del" onclick="startEdit(${x.id})">Edit</button>
      <button class="del ${armed === x.id ? 'armed' : ''}" onclick="del(${x.id})">${armed === x.id ? 'Tap again to delete' : 'Delete'}</button></div></div>
      ${res}${x.photo ? `<img class="photo" loading="lazy" src="${esc(photoUrl(x.photo))}" alt="Photo of the finished board" onclick="showPhoto(${x.id})">` : ''}${x.notes ? `<p class="note">${esc(x.notes)}</p>` : ''}</div>`;
  }).join('');
  // "Erase all" only appears without a filter, so it can't be mistaken for "erase the filtered games".
  const erase = expFilter !== 'all' ? '' : `<p class="foot"><button class="del ${armed === 'all' ? 'armed' : ''}" onclick="del('all')">${armed === 'all' ? 'Tap again to erase everything' : 'Erase all games'}</button></p>`;
  return `${filterBar()}<p class="lead">${games.length} ${games.length === 1 ? 'game' : 'games'}, newest first</p>${cards}${erase}`;
}

// Rebuilds the visible screen from the current state. Call it after ANY change to the state.
function render() {
  const titles = { board: 'Leaderboard', new: editingId ? 'Edit game' : 'New game', history: 'Game history' };
  const body = { board: renderBoard, new: renderNew, history: renderHistory }[tab]();
  const box = photoView ? `<div class="lightbox" onclick="photoView='';render()"><img src="${esc(photoView)}" alt="Photo of the finished board"></div>` : '';
  $('app').innerHTML = `<h1>${titles[tab]}</h1>${body}${box}`;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
}

/* ============================================================
   6. ACTIONS - what happens when the user taps something
   ============================================================
   Pattern: write to the database (await) -> reload data.games -> render(). */
// Switch tab (called by the bottom navigation).
function go(t) { if (editingId && t !== 'new') resetForm(); tab = t; formErr = ''; render(); window.scrollTo(0, 0); if (t !== 'new') refresh(); }

// Reloads the games from the database and redraws. Called at start and whenever you open
// Leaderboard or History, so games added by friends show up.
async function refresh() {
  try { data.games = await loadGames(); }
  catch (e) { toast('Could not load games'); console.error(e); }
  render();
}
// Empties the form and leaves edit mode.
function resetForm() { dropNewPhoto(); editingId = null; rows = blankRows(); draft = freshDraft(); formErr = ''; }

// Edit = open the form filled with the game's current values. Saving then calls updateGame().
function startEdit(id) {
  const g = data.games.find(x => x.id === id);
  if (!g) return;
  editingId = id;
  rows = g.results.map(r => ({ name: r.name, vp: String(r.vp) }));
  while (rows.length < 3) rows.push({ name: '', vp: '' });
  dropNewPhoto();
  draft = { date: g.date, exp: g.expansion, notes: g.notes, photoFile: null, photoPreview: '', photoPath: g.photo || '' };
  formErr = ''; tab = 'new'; render(); window.scrollTo(0, 0);
}
function cancelEdit() { resetForm(); go('history'); }

// Forgets a newly chosen (not yet uploaded) photo.
function dropNewPhoto() { if (draft.photoPreview) URL.revokeObjectURL(draft.photoPreview); draft.photoFile = null; draft.photoPreview = ''; }

// Called when a photo is picked: shrink it, remember it in the draft, redraw with a preview.
async function pickPhoto(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  try {
    const blob = await shrinkImage(f);
    dropNewPhoto();
    draft.photoFile = blob; draft.photoPreview = URL.createObjectURL(blob);
    render();
  } catch (e) { toast('Could not read that photo'); console.error(e); }
}
// Remove: first drops a newly chosen photo; if there is none, drops the saved one.
function removePhoto() { if (draft.photoFile) dropNewPhoto(); else draft.photoPath = ''; render(); }
function showPhoto(id) { const g = data.games.find(x => x.id === id); if (g && g.photo) { photoView = photoUrl(g.photo); render(); } }

function addRow() { if (rows.length < 6) { rows.push({ name: '', vp: '' }); render(); } }
function rmRow(i) { if (rows.length > 3) { rows.splice(i, 1); render(); } }

// Returns an error message, or '' if the game is valid.
function validate(res) {
  if (res.length < 3) return 'Add at least 3 players, each with a name and victory points.';
  if (res.some(r => !r.name || isNaN(r.vp))) return 'Every player needs a name and a VP count.';
  if (res.some(r => r.vp < 0 || r.vp > 30)) return 'Victory points must be between 0 and 30.';
  const seen = new Set();
  for (const r of res) { const k = r.name.toLowerCase(); if (seen.has(k)) return r.name + ' appears twice. Each player can only be listed once.'; seen.add(k); }
  return '';
}
// Validate -> save (new game or edited game) to the database -> reload -> jump to History.
async function saveGame() {
  if (saving) return;
  const res = rows.map(r => ({ name: canon(r.name.trim()), vp: parseInt(r.vp, 10) })).filter(r => r.name || !isNaN(r.vp));
  formErr = validate(res);
  if (formErr) { render(); return; }
  const wasEdit = editingId !== null;
  saving = true; render();
  let uploaded = null;
  try {
    let photo = draft.photoPath || null;                      // saved photo, unless removed
    if (draft.photoFile) uploaded = photo = await uploadPhoto(draft.photoFile);
    const game = { date: draft.date || today(), expansion: draft.exp, notes: draft.notes.trim(), photo, results: res };
    if (wasEdit) {
      const old = data.games.find(x => x.id === editingId);
      await updateGame(editingId, game, old);
      uploaded = null;
      if (old.photo && old.photo !== photo) removePhotos([old.photo]);   // replaced or removed
    } else { await addGame(game); uploaded = null; }
    data.games = await loadGames();
  } catch (e) {
    if (uploaded) removePhotos([uploaded]);                  // the game was not saved, so drop the upload
    saving = false; formErr = 'Could not save: ' + e.message; render(); return;
  }
  saving = false;
  if (wasEdit) resetForm(); else { rows = blankRows(); draft.notes = ''; dropNewPhoto(); }
  tab = 'history'; render(); window.scrollTo(0, 0);
  toast(wasEdit ? 'Changes saved' : 'Game saved');
}

// 1st tap 'arms' the button (red for 3 seconds), 2nd tap deletes. id === 'all' erases everything.
async function del(id) {
  if (armed === id) {
    armed = null;
    try {
      const paths = id === 'all' ? data.games.map(g => g.photo) : data.games.filter(g => g.id === id).map(g => g.photo);
      if (id === 'all') await deleteAll(); else await deleteGame(id);
      removePhotos(paths);                                     // also delete the photo files
      data.games = await loadGames();
    } catch (e) { toast('Could not delete'); console.error(e); }
    render(); return;
  }
  armed = id; render();
  setTimeout(() => { if (armed === id) { armed = null; render(); } }, 3000);
}

/* ============================================================
   7. START - show "Loading", fetch the games, draw the first screen
   ============================================================ */
async function init() {
  $('app').innerHTML = '<p class="lead">Loading…</p>';
  await refresh();
}
init();
