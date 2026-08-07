# ChatChat — a small web chat

A small self-hosted chat app: create an account, log in, chat in public
channels or invite-only private ones, and use a handful of slash
commands. Clean black-background / white-outline look that switches to
light mode automatically with your OS, real backend, no frontend build
step.

## Stack

- **Backend:** Node.js, Express (HTTP + REST auth), `ws` (WebSocket chat),
  `bcryptjs` (password hashing — pure JS, no native build step)
- **Storage:** flat JSON files (`users.json`, `channels.json`), created
  automatically. Good for personal/small-group use; swap the
  `load`/`save` helpers in `server.js` for a real database if you need
  more.
- **Frontend:** plain HTML/CSS/JS, no build step

## Setup

```bash
cd chatchat
npm install
npm start
```

Then open **http://localhost:3000**.

To use a different port: `PORT=8080 npm start`.

## Deploying it publicly

This is a plain Node process with a WebSocket server and a flat-file
"database" — no build step, no serverless functions. That means two
things matter when picking a host:

1. **It needs a long-running process**, not a serverless/edge function
   platform — those kill the process between requests and can't hold
   a WebSocket connection open. Any normal Node host works (Railway,
   Render, Fly.io, a VPS, etc.); a static-site or functions-only host
   (Vercel, Netlify, Cloudflare Pages) doesn't.
2. **It needs persistent disk.** `users.json`, `channels.json`, and
   `silences.json` are written to whatever `DATA_DIR` points at
   (`server.js`, defaults to the project folder). Most PaaS hosts give
   you an *ephemeral* filesystem by default — fine while the process
   stays up, but wiped on every redeploy or restart. Set `DATA_DIR` to
   a mounted persistent volume/disk, or every account gets deleted the
   next time you ship a change.

A `Dockerfile` and `docker-compose.yml` are included, so most hosts
below can deploy straight from this folder with no extra config beyond
setting up storage.

### Option A: Railway (probably the easiest)

1. Push this folder to a GitHub repo.
2. [railway.app](https://railway.app) → New Project → Deploy from GitHub repo.
3. It auto-detects the `Dockerfile`. Add a **Volume**, mount it at
   `/app/data`, and set the env var `DATA_DIR=/app/data`.
4. Railway gives you a public `*.up.railway.app` URL over HTTPS/WSS
   automatically. Add a custom domain later under Settings if you want.

### Option B: Fly.io

1. Install `flyctl`, then from this folder: `fly launch` (it'll find
   the `Dockerfile`).
2. `fly volumes create chatchat_data --size 1` to create persistent
   storage, then in `fly.toml` add:
   ```toml
   [mounts]
     source = "chatchat_data"
     destination = "/app/data"

   [env]
     DATA_DIR = "/app/data"
   ```
3. `fly deploy`. Fly gives you a `*.fly.dev` URL with TLS out of the box.

### Option C: Render

Works the same way (New → Web Service → connect the repo, it picks up
the `Dockerfile`), but **persistent disks require a paid instance
type** — on Render's free tier, `DATA_DIR` has nowhere durable to
point, and a redeploy or the free tier's auto-sleep/restart cycle will
wipe every account. Fine to try it out; add a paid instance + a
Render Disk mounted at `/app/data` before treating it as a real deploy.

### Option D: Your own VPS (DigitalOcean, Hetzner, etc.), full control

```bash
git clone <your repo> && cd chatchat
docker compose up -d --build
```

`docker-compose.yml` already mounts a named volume at `/app/data`, so
your data survives container rebuilds. You'll want a reverse proxy in
front for HTTPS/WSS — Caddy is the least fuss (automatic TLS from a
domain name):

```
your-domain.com {
  reverse_proxy localhost:3000
}
```

### Before you tell anyone the URL

- **Claim the `Daniel` account yourself first.** Whoever registers
  that exact username (case-insensitive) gets every hidden moderator
  power described in "Who can make a public channel" and "Moderation"
  above — there's no separate admin flag, it's just that username.
  Register it the moment the server is up, before sharing the link.
- **The profanity filter calls a Cloudflare Worker that isn't yours**
  (`chatchatprofanity.daniel-torres-a95.workers.dev`, proxying
  `vector.profanity.dev`). It'll keep working as long as that worker
  stays up, but you don't control it. To own that piece, deploy your
  own copy of the Worker code and change `PROFANITY_WORKER_URL` in
  `public/app.js`.

## How it works

- **On narrow/portrait screens**, the chat itself fills the whole
  screen and the sidebar (channels, invites, users, commands) is
  hidden by default. There's no header bar at all — instead a small
  floating **☰** button sits on top of the chat, and is itself
  draggable: a real drag moves it anywhere on screen (its position is
  remembered between visits), while a plain tap opens the sidebar as a
  floating popup you can separately drag around by its "Menu" title
  bar, and close with **✕** or by picking a channel. Desktop layouts
  are unaffected; the sidebar just stays docked on the left as usual,
  and the floating button never appears at all.
- **Favicon**: `public/favicon-32.png`, `favicon-192.png`, and
  `apple-touch-icon.png` are generated from a single source image and
  linked in `index.html`. Swap in your own by regenerating those three
  sizes from a new square image and overwriting the files — no other
  changes needed.
- **Register** picks a username (3–16 characters, must start with a
  letter, letters/numbers/`_`/`-` only) and a password (6+ characters).
  Registration fails if the name is already taken. Passwords are hashed
  with bcrypt before being written to disk — never stored in plain text.
- **Login** checks the username/password against `users.json` and issues
  a session token, saved in your browser so you stay logged in on
  refresh.
- Everyone starts in **#main**, a public channel. The sidebar's
  "Channels" list is the only place channels are browsed/joined from —
  there's no redundant channel name in the header, since the sidebar
  always highlights the one you're in. It also shows a live count of
  people in each channel, and a total-online figure at the top.
- **Private channels** are invite-only, and are what regular accounts
  get by default — see "Who can make a public channel" below. Members
  can invite others; an invited person sees a system notice and a card
  in the "Invites" sidebar with **Accept**/**Decline** buttons (or the
  equivalent commands). Accepting adds you to the channel's permanent
  member list; declining just drops the invite.
- **Muting** is entirely local: `/mute`, `/unmute`, and `/mlist` never
  touch the server. They just hide/show a given nickname's messages on
  your own screen.
- **The profanity filter** (`/ff`) is also entirely local — it's a
  toggle, off by default. While on, every message you receive (chat,
  actions, whispers) is sent to a small Cloudflare Worker proxy in
  front of `vector.profanity.dev` for a check before it renders; a
  flagged message shows as a dashed "hidden — click to unhide"
  placeholder instead of its text. Clicking it reveals just that one
  message; running `/ff` again turns checking off for anything new
  (already-hidden messages stay hidden until clicked). If the check
  fails or times out, the message is shown as-is rather than getting
  stuck — this is a casual filter, not a moderation system.
- **Channels keep working in the background.** You only have one
  channel open at a time, but messages for every public channel (and
  every private one you belong to) keep arriving and getting tagged
  with whichever channel they're actually from — you're just not
  shown them until you switch there. Switch back and forth and nothing
  is missing, it was just hidden. Direct replies to your own commands
  (whispers, `/whowas`, errors, and so on) aren't tied to a channel at
  all, so those stay visible no matter what you're looking at.
- **"X joined #channel" / "X left #channel"** notices are reserved for
  actual membership changes — accepting an invite or running `/leave`
  — not for routine `/join` browsing between public channels, since
  that would fire constantly and drown out real conversation.
- **Profile pictures** (`/pfp <url>`) are a direct image link stored on
  your account, shown next to your name in the user list and next to
  your messages. They're rendered inside a crisp, unblurred circular
  frame with a blurred image inside it — only the picture's content is
  obscured, not its outline — since the server can't screen a raw link
  for inappropriate or violent content, this keeps anything shown
  deliberately hard to make out, with no hover-to-reveal or
  click-to-unblur. If the image fails to load, it's just quietly
  hidden rather than showing a broken-image icon.

## Commands

While typing a command, a dropdown of suggestions appears above the
input for any argument that has a known set of values: usernames
(matched against everyone currently online server-wide, closest match
first), channel names, or a fixed set of options (like `/silence`'s
`c`/`nc` or `/delete`'s `acc`/`chnl`). The same suggestions appear when
typing an `@mention` in a plain chat message, not just inside a
command. Use **↑/↓** to move through suggestions, **Tab** or **Enter**
to accept the highlighted one, or click one directly; **Esc** dismisses
it. It only takes over ↑/↓ while a dropdown is actually showing —
otherwise those keys still recall your command history as usual.
Purely a client-side typing aid; it suggests from whatever the client
already knows (online users, known channels) and never blocks you
from typing something else.

| Command | Effect |
|---|---|
| `/nick <name>` | Change your on-screen nickname for this session |
| `/me <action>` | Send an action message, e.g. `/me waves` → `* you waves` |
| `/msg <user> <text>` (or `/w`) | Send a private whisper to one online user, anywhere on the server |
| `@name` (in a normal message) | Ping up to 2 people in your current channel — see "Pinging" below. Not a command; just type it into a message |
| `/list` | List everyone in your current channel |
| `/channels` | List public channels and the private ones you belong to |
| `/create <name>` | Create a channel. Max 5 channels per IP address (see note below on public vs. private) |
| `/join <name>` | Switch to a public channel, or a private one you're a member of |
| `/invite <user> [channel]` | Invite someone to a private channel you're in (defaults to your current channel). Re-inviting the same person is limited to once per 1 min 50 sec |
| `/invites` | List your pending invites — who invited you and who created each channel |
| `/accept <channel>` | Accept a pending invite and join |
| `/decline <channel>` | Decline a pending invite |
| `/leave` | Leave the private channel you're currently in (does nothing in public channels — just `/join` elsewhere) |
| `/pfp <image url>` (or `/avatar`) | Set your profile picture to a direct link to an image. `/pfp none` removes it |
| `/blockinvites <user>` | Stop that account — and any new account they make from the same connection — from ever inviting you again. Silent to them; see "Blocking invites" below |
| `/unblockinvites <user>` | Reverse `/blockinvites` |
| `/mute <user>` | Hide a nickname's messages, whispers, and pings — only on your own screen |
| `/unmute <user>` | Reverse `/mute` |
| `/mlist` | Show who you've muted (also only visible to you) |
| `/ff` | Toggle the local profanity filter on/off (see above) |
| `/silence <user>` / `/unsilence <user>` | For non-moderators, these are just aliases for `/mute`/`/unmute` — see "Moderation" below |
| `/appeal <text>` | Contest an active silence — 2 tries/300 chars normally, 3/400 if it's permanent. Only usable while you're actually silenced |
| `/report <user1[,user2,user3]> <reason>` | Report up to 3 people to the moderators, with up to 5 of their messages attached as evidence (click the ⚑ next to a message in the log to select it). See "Reports" below |
| `/mods` | List current moderators |
| `/whowas <name>` | Show every nickname an account has ever gone by |
| `/help` | Show the command list |
| `/quit` | Disconnect |
| `/logout` | Disconnect, forget your saved session on this browser, and return to the login screen (this is what the old "Disconnect" button used to do — there's no button for it anymore, just this command) |
| `/delete acc <password> <password again>` | **Permanently deletes your account.** Requires your current password, typed twice to confirm. See "Account deletion" below |
| `/delete chnl <channel name>` | Deletes a channel — you can only delete a private channel you created yourself (never `#main`, never a public channel). See "Account deletion" below |

Anything not starting with `/` is sent as a normal chat message to
everyone currently in your channel. Messages support basic markdown:
`**bold**`, `*italic*` (or `_italic_`), `~~strikethrough~~`, `` `code` ``,
and `[link text](https://...)`. It's applied client-side after your
message is already HTML-escaped, so it only ever adds formatting —
there's no way to inject raw HTML through it.

## Pinging

Pinging isn't a slash command — just put `@theirname` in an ordinary
message, e.g. `@alice can you check this?`. Up to 2 valid mentions per
message count (only people currently online *in the same channel* as
you match); anything past the first 2, or a name that doesn't match
anyone in the channel, is left as plain text. A matched mention is
rendered highlighted for everyone, and the row is emphasized on the
screen of anyone it targets.

Pinging (i.e. sending a message containing a valid mention) is limited
to once per minute per sender. If you're still on cooldown, the
message still sends as normal chat — the `@mentions` just won't be
highlighted that time, and you'll get a private note saying so.

## Who can make a public channel

`/create <name>` always makes a **private** channel for ordinary
accounts, no matter what you type after the name — private-by-default
is intentional so random users can't spam the public channel list.

There's one hardcoded exception: the account whose username is
`Daniel` (matched case-insensitively) can add a trailing argument to
choose:

```
/create general pbl     → public
/create general         → private (default for Daniel too)
/create general prv     → private (explicit)
```

This isn't advertised in the in-app `/help` text — it's a quiet
admin-style override, not a general feature. Look at the `/create`
case in `server.js` if you want to change who qualifies or remove the
special case entirely.

## Moderation

`Daniel` (the hardcoded top-level admin — same account that gets the
public-channel exception above) can promote other accounts to
**moderator** status. Moderators get real enforcement power via
`/silence`/`/unsilence` and can review appeals, but a few things stay
Daniel-exclusive: making public channels, deleting channels that
aren't their own, and managing who else is a moderator.

For everyone who isn't a moderator, typing `/silence <user>` is just
an alias for `/mute <user>` — client-side only, permanent until
`/unmute`, nothing enforced.

### Managing moderators

```
/addmod alice          → Daniel only: makes alice a moderator immediately
/removemod alice        → Daniel only: revokes it immediately
/mods                   → anyone: lists current moderators
/requestmod alice        → moderators only: asks Daniel to add alice
/requestunmod alice      → moderators only: asks Daniel to remove alice
/modreqaccept alice      → Daniel only: approves a pending request
/modreqdecline alice     → Daniel only: rejects one
```

Moderators can't add or remove each other directly — only request it.
Pending requests show up in Daniel's "Mod requests" sidebar panel with
approve/reject buttons, alongside the commands above.

### Silencing

For a moderator (Daniel included):

```
/silence bob 120 nc            → real silence, 120 seconds (nc = default if omitted)
/silence bob 120 c             → client-only mute, just on your screen, auto-lifts after 120s
/silence bob perm nc reason...  → permanent silence, with a reason shown to bob and to mods
/unsilence bob                  → lifts a real silence early
```

A real (`nc`) silence:

- Blocks `bob` from sending chat messages or `/me` for the duration —
  he gets a system message explaining how long is left (or that it's
  permanent), the reason if one was given, and reminding him he can
  `/appeal`.
- Blocks `bob` from logging in or reconnecting (fresh login or a
  resumed browser session) until it's lifted. If he's still connected
  in an existing tab when the silence starts, that connection stays
  open (read-only for chat) — that's intentional, since it's his only
  way to actually submit an appeal.
- Persists in `silences.json` and survives server restarts.

**Permanent silences** (`perm` instead of a number of seconds) raise
the appeal limits from the normal 2 tries/300 characters to **3
tries/400 characters**, since there's no expiry to just wait out.

**Appeals:** while actively silenced, `bob` can run `/appeal <text>`
up to his limit (2/300 normally, 3/400 if permanent). Any moderator —
not just Daniel — sees pending appeals in the sidebar's "Appeals"
panel with Accept/Decline buttons, or via `/modaccept <user>` /
`/moddecline <user>` directly. Accept lifts the silence immediately;
decline clears the appeal but leaves the silence running (`bob` can
still send another appeal later if he has one left).

### Reports

Anyone can file one:

```
/report bob rude in #general
/report bob,alice,carl brigading — see attached
```

Up to 3 people per report, and up to 5 of their messages attached as
evidence — click the small ⚑ next to a message in the log to select
it first (a status bar above the input shows how many you've picked,
with a Clear button). You can report the same person at most twice —
reporting them a third time just gets skipped with a note, even if
they're bundled in with others who aren't maxed out yet.

Filed reports show up automatically in every moderator's "Reports"
sidebar panel — nothing to run to go see them. `/reportclear <id>` (or
the panel's "clear" button) dismisses one once it's been dealt with.
Reports aren't persisted to disk — they're lost on a server restart,
same as invites and mod requests.

### `/modhelp`

A hidden command that reprints a cheat-sheet of everything above,
scoped to what you can actually do — moderators see the silence/appeal
commands, Daniel additionally sees the public-channel/delete-any-
channel/mod-management notes. Anyone else gets "Unknown command."
None of this is mentioned in the general `/help` text.

## Account deletion & channel deletion

`/delete` has two forms:

**`/delete acc <password> <password again>`** permanently deletes your
own account. Both arguments must match each other and your real
current password (checked with bcrypt) — get either wrong and nothing
happens. On success, the server:

- Removes your account from `users.json` (including your nickname
  history)
- Removes you from every private channel's member list in
  `channels.json`
- Drops any invites and any silence/appeal record tied to you
- Invalidates every session token tied to your account (so old
  logged-in tabs stop working)
- Clears your message/ping/invite rate-limit timers
- Disconnects you and returns your browser to the login screen

There's no undo. Channels you created keep existing (with their
existing members), just without you as a member; the creator field
falls back to showing your old lowercase username if you were the
creator, since the account record itself is gone. This command parses
the password and confirmation as plain whitespace-separated arguments,
so it won't work correctly if either one contains a space.

**`/delete chnl <channel name>`** deletes a channel — no password
needed. The rules:

- `#main` can never be deleted, by anyone, ever.
- Anyone can delete a **private** channel they personally created.
- Only the `Daniel` account can delete a **public** channel (and, per
  `/modhelp`, Daniel can actually delete any channel at all — see
  "Moderation" above).

Deleting a channel moves anyone currently in it back to `#main` with a
system notice, drops any pending invites that pointed at it, and
updates everyone's sidebar channel list.

## Blocking invites

`/blockinvites <user>` stops that account from ever inviting you to a
channel again — permanently, until you `/unblockinvites` them. The
person must be online when you run it, since the block is recorded
against their current IP address rather than just their username, so
it also covers any new account they create from that same connection
afterward.

The person you block is never told. If they try to `/invite` you
after being blocked, they see the exact same "Invited X" success
message as always — the invite just silently never reaches you and
never shows up in your "Invites" sidebar. Their invite cooldown still
updates normally too, so nothing about their experience looks any
different from a real invite going through.

## Rate limits & quotas

- **Channel creation:** 5 channels total (public or private combined)
  per IP address, tracked by the IP that created each channel in
  `channels.json`.
- **Invites:** you can re-invite the same person to a channel only once
  every 1 minute 50 seconds (tracked per inviter → invitee pair).
- **Pinging:** once per minute per sender (see "Pinging" above), and a
  message can only carry up to 2 valid pings, both of whom must share
  your current channel.
- **Message pacing:** ordinary chat messages (and `/me` actions) are
  throttled per account — after sending one, you must wait before
  sending the next. The wait scales with how long the message was:

  | Message length | Wait before your next message |
  |---|---|
  | up to 20 characters | 1 second |
  | up to 60 characters | 2 seconds |
  | up to 120 characters | 3 seconds |
  | up to 200 characters | 4 seconds |
  | up to 320 characters | 5 seconds |
  | longer | 6 seconds |

  Sending too soon doesn't queue the message — it's rejected with a
  system notice telling you how much longer to wait.

## Notes & limitations (by design, since this is a small starter project)

- Sessions and rate-limit timers live in memory, so they reset if the
  server restarts. Accounts (including mod status and password),
  channels, channel membership, and real silences are saved to disk
  and survive restarts. Pending invites, mod requests, and filed
  reports are in-memory only, like sessions — a restart clears them.
- Only one connection per account at a time — logging in elsewhere
  first will block a second connection until the first disconnects.
- No message history/persistence across restarts or reconnects — the
  chat log only exists in each connected browser tab's memory. While
  you're connected, though, you do keep accumulating messages for
  every channel you're in, not just the one currently on screen (see
  "Channels keep working in the background" above); reconnecting
  starts that log over from empty.
- Mutes are stored per-browser (`localStorage`) and keyed by nickname,
  not account — if someone changes their nickname with `/nick`, a mute
  on their old name won't follow them to the new one.
- IP tracking uses the raw socket address. If you put this behind a
  reverse proxy, everyone will appear to share one IP unless you adapt
  `server.js` to read `X-Forwarded-For`.
- `/pfp` only checks that the input looks like an `http(s)` URL — the
  server never fetches it (avoids exposing itself to SSRF), so nothing
  stops someone from setting a link to a non-image page. The browser
  will just quietly fail to render it (the broken-image icon is
  suppressed) if it isn't one.

## Project structure

```
chatchat/
├── package.json
├── server.js          # Express + WebSocket backend: auth, channels, invites, commands
├── Dockerfile          # for Railway/Fly/Render/self-hosting
├── docker-compose.yml   # for self-hosting with a persistent volume
├── users.json          # created on first registration
├── channels.json        # created on first run (holds #main + anything users create)
├── silences.json         # created on first real (nc) /silence, if ever used
└── public/
    ├── index.html      # auth screen + chat screen
    ├── style.css        # black-background / white-outline theme (auto light mode)
    ├── app.js          # boot animation, auth calls, WebSocket + rendering, local mute logic
    ├── favicon-32.png
    ├── favicon-192.png
    └── apple-touch-icon.png
```
