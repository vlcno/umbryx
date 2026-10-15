# Umbryx

A self-hosted chat app in the spirit of Discord: text channels, voice channels, one-on-one calls,
friends, direct messages, profiles with animated pictures and banners, 200 MB file uploads, and
screen sharing up to 4K at 60 fps with sound.

There are two parts:

| Part | What it is | Where it runs |
| --- | --- | --- |
| `Umbryx.exe` | The app people use. | Windows |
| `server` folder | The server everyone connects to. | Linux (Ubuntu) in Docker, deployed with Portainer |

## The Windows app

Unzip `Umbryx-Windows.zip` anywhere and double-click `Umbryx.exe` inside the `Umbryx` folder. It
is a self-contained program with its own window: no browser is involved and nothing is installed.
Keep the files in that folder together.

- **Server address:** `server-address.txt` in the folder holds the address to connect to
  (`https://us.vlcno.xyz`), so nobody has to type it. Without that file the app asks for the address
  the first time; a name like `us.vlcno.xyz` can be typed without a port.
- **Security question:** none for `us.vlcno.xyz`, which has a real certificate (through Cloudflare).
  A server reached by its IP address makes its own certificate: the app asks once whether to trust
  it and then remembers it, and warns you if the certificate ever changes.
- **Microphone:** no prompt. The app grants the microphone to the server it is connected to, and
  to nothing else.
- **Screen sharing:** the app shows its own picker with every screen and window.
- **Title bar:** the app has no Windows title bar. A black strip along the top carries the logo
  and the server's name at the left and the minimise, maximise and close buttons at the right.
  Drag the window by that strip; double-click it to maximise. If the connection to the server
  drops, "Reconnecting…" shows there in red until it is back.
- **Several servers:** a narrow column down the left lists your servers. Click one to show it;
  **+** at the bottom adds another by its address (Ctrl+Shift+S does the same, as does
  `Change server.bat`). Each server keeps its own sign-in, and the ones not on screen stay
  connected in the background, so a call carries on while you look at another server. A red
  number on a server counts its unread messages, and a green ring means a call is ringing there.
  Right-click a server to reload it or remove it from the list.
- **App menu:** open Settings and click **App menu** for reload, zoom and full screen
  (Ctrl+R, Ctrl+= / Ctrl+- / Ctrl+0 and F11 work too), **Check for updates** and the version.
- **Updates:** from version 1.3 the app updates itself through your server. When a new version is
  out, a green arrow appears at the bottom of the column of servers; click it and Umbryx restarts
  on the new version a few seconds later, with your servers, sign-ins and settings as they were.
  It never restarts by itself, and asks first if you are in a call. See "Desktop app updates".
- **Giving it to friends:** send them the zip.

Anyone without the app can use a browser instead: `https://umbryx.vlcno.xyz` (or
`https://YOUR-SERVER:3443` for a server of your own).

**Invite links:** admins copy invite links from Server settings, like `https://us.vlcno.xyz/K7QM2XPA`.
Opening one fills in the code: in Create account for someone new, or as "Join the server?" for an
account not in the server yet. Any code box also takes a pasted link.

## The Mac app

`Umbryx-Mac.zip` holds `Umbryx.app` for Macs with Apple chips (M1 and later). It is not signed by
Apple, so after unzipping it needs a local signature before it opens. In Terminal, in the folder the
zip was saved to (this replaces an older Umbryx in Applications; your servers and sign-ins are kept
elsewhere and stay):

```bash
ditto -x -k Umbryx-Mac.zip Umbryx-Mac && rm -rf /Applications/Umbryx.app && mv Umbryx-Mac/Umbryx.app /Applications/ && xattr -cr /Applications/Umbryx.app && codesign --force --deep --sign - /Applications/Umbryx.app && open /Applications/Umbryx.app
```

It works like the Windows app, with the window buttons at the top left, and updates itself the same
way. The Mac asks once for the microphone and camera, and for screen recording the first time you
share your screen (after allowing it in System Settings > Privacy & Security > Screen & System Audio
Recording, open Umbryx again). After an update it may ask for the microphone and camera again: the
update signs the app locally again, as the command above does, and to macOS that is a new app.
Sharing your screen's sound is Windows only.

To rebuild it (on Windows): `python tools/make_icon.py`, build the Windows app (its `app.asar` goes
into the Mac app too), then
`python tools/make_mac_app.py electron-v<version>-darwin-arm64.zip downloads/Umbryx-Mac.zip`, using
Electron's macOS zip for the version in `desktop/package.json`.

## Desktop app updates

From version 1.3 the Windows and Mac apps update themselves through the Umbryx servers they know.

- **Checking:** 15 seconds after starting and then every 4 hours, the app asks each of its servers
  for `/updates/latest.json`, the description of the newest version. **Check for updates** in the
  app menu asks straight away.
- **Trust:** that description is signed with a private key that only exists on the computer the app
  is built on (`%USERPROFILE%\umbryx-build\update-signing-key.pem`). The app carries the public
  half and ignores anything that key did not sign, and the server only accepts what it signed, so
  nobody else can push an update to the apps, not even someone who takes over the server. Keep a
  copy of that key somewhere safe and private (a USB stick, a password manager): without it no
  more updates can be published, and anyone who has it could publish one.
- **Downloading:** in the background. Usually only the app's own code changes, a few hundred KB
  (`app.asar`, the same file for Windows and Mac). When the Electron version underneath changes,
  the whole app is downloaded instead. The download is checked against the description before
  anything is used.
- **Installing:** clicking the green arrow closes Umbryx; a small helper (PowerShell on Windows,
  the shell on a Mac) puts the new files in place, keeps `server-address.txt`, and opens Umbryx
  again. A failed copy leaves the old version working.
- **Where it cannot:** a copy in a folder it may not write to (such as Program Files) says so
  under **Check for updates** and has to be updated by hand. The iPhone app is not covered; it
  updates through TestFlight or the App Store.

**Publishing a new version** (on the computer with the key):

1. Raise `version` in `desktop/package.json`, then run `desktop\build.bat`.
2. `python tools/publish_update.py --notes "What changed"`

That sends the new version to the server in `server-address.txt` (give `--server` for another)
and every app picks it up within a few hours. Only when the build uses a different Electron
version add the two download zips: `--windows downloads/Umbryx-Windows.zip --mac
downloads/Umbryx-Mac.zip`. `--dry-run` checks everything without sending. The server keeps the
files in its data folder (`updates`), so updating the server itself does not remove them.

## The server

See [server/README.md](server/README.md) for the Portainer steps. In short: copy `server.py`,
`certgen.py` and `public` to `/opt/umbryx/app` on the Ubuntu machine, paste
`server/docker-compose.yml` into a new Portainer stack, set `UMBRYX_HOSTS` to the server's
address, and deploy.

## What is in the app

- **Accounts.** Create one on the sign-in screen. Usernames can be changed any time in Settings.
  The **Sign in automatically on this device** box (on by default) keeps that device signed in.
- **Invite codes.** A new account starts in direct messages (like a guest, below) until it has an invite
  code: typed when making the account, or later at the top of the sidebar. Admins make codes in Server
  settings (for 1, 5, 25 or any number of people, for 1, 7 or 30 days or for good) and see who joined with
  each. `"inviteOnly": false` in `config.json` lets new accounts join straight away.
- **Removing someone from the server.** Admins have **Kick from server** on a member's profile card. The
  person keeps their account and their direct messages with friends, but is back outside the server (like an
  account without an invite code) until an admin gives them a new code. Admins, and accounts in
  `canDeleteStaff`, cannot be removed.
- **Deleting an account.** Settings > Profile > **Delete account**: type your username and password. Umbryx
  Staff can delete other people's accounts (not Staff's) from their profile card, after "are you sure?";
  accounts listed in `canDeleteStaff` can delete anyone's, and nobody else can delete theirs. Messages stay,
  shown as **Deleted user**; the profile, pictures, friends and sign-ins go, and the username is free again.
- **Guests.** **Skip for now** on the sign-in screen goes in without an account, as `guest-4821`
  (renamable like any username). A guest sees none of the server: no channels, voice rooms, messages
  or member list. They add friends by username and can message and call those friends once they say
  yes, and members see a guest only once they are friends or one asks them. Guests customise their
  profile like anyone (picture, banner, display name, colour, bio, nameplate, theme). At first the account
  lives on that device alone; **Make an account** (at the top of the guest's sidebar) gives it a password, so
  they can sign in anywhere, and they stay a guest. An admin can let a guest who has an account into the
  server with **Let into server** on their profile card. Turn guests off with `"guests": false` (see `server/README.md`).
- **Text channels.** Reading and chatting never puts you in a voice channel.
- **Message buttons.** Hover a message for **Reply**, **Pin** and, on your own messages, **Edit**
  and **Delete**.
  - A reply shows who and what it answers above it; click that line to jump to the original.
  - Edit with the pencil, by double-clicking your message, or by pressing the up arrow in an empty
    message box. Enter saves, Escape cancels, and an edited message is marked "(edited)".
  - Anyone in a conversation can pin and unpin. The pin button at the top of a channel or direct
    message lists what is pinned (up to 50 per conversation).
  - Delete removes the message for everyone straight away, with no confirmation, along with its
    attached files. You can only delete your own messages.
- **Emoji.** The smiley button in the message box opens the picker: recently used, this server's
  own emoji, then every Unicode emoji by category, with a search box. A message that is only emoji
  is drawn large. **Add emoji** in the picker uploads a picture or GIF as a server emoji that
  everyone can use by typing `:its_name:`; right-click one in the picker to remove it.
- **Spoilers.** Before sending a picture or video, click the eye on its chip to hide it behind a
  spoiler cover that each reader clicks to reveal. `||text||` hides text the same way.
- **Pictures and GIFs.** Clicking one opens it in a viewer inside the app. Click the picture to
  zoom in towards the spot you clicked, and click again to zoom back out. Escape closes it.
- **Videos.** Play in Umbryx's own player: play, seek, volume, mute and full screen. The player takes
  the video's own shape (up to 560 by 420), so a phone video stands tall.
- **Sound files.** Play in a card with the file's name and size, play, seek and volume. Hover the
  card for a download button; clicking the name downloads too.
- **Upload previews.** Files you attach, paste or drag onto the chat show as cards above the
  message box before you send: pictures, GIFs and videos as thumbnails, other files as an icon,
  each with its name and size and a button to remove it.
- **Favorites.** The star at the top right of any picture, GIF or video saves it. The star button
  in the message box opens your favorites; click one to send it.
- **Typing status.** "Abby is typing…" with moving dots shows above the message box, and the same
  dots appear next to that channel or direct message in the list. It goes away the moment the
  person sends or empties the box.
- **Custom status.** Click your own name (bottom left), then **Set a custom status**. Type a line
  and choose when it clears: 24 hours, 4 hours, 1 hour, 30 minutes, or never. It shows under your
  name in the member list and on your profile card.
- **Name color.** Settings has a color picker and a row of ready-made colors for your name;
  **Automatic** goes back to the color worked out from your name. Colors too dark to read on black
  are lightened when shown.
- **Renaming channels.** Hover a text or voice channel and click the pencil.
- **Voice channels.** Clicking one joins it and leaves you in the conversation you were reading;
  click it again (or the "Voice connected" panel) to open the voice window. Mute, deafen and
  per-person volume are built in. Your ping to the server shows next to "Voice connected" from the
  moment you join.
- **Camera.** The camera button in a voice channel or call sends your camera (720p) to everyone
  there. Pick which camera in Settings. While cameras are on, every tile grows to fill the voice
  window. Click a camera to put it in focus (everyone else goes to a strip underneath; click again
  or press Escape to go back); double-click it, or use the button in its corner, for full screen.
- **Floating camera preview.** While someone else in your voice channel or call has a camera on
  and you are looking at a text channel, a message thread or Friends, a small picture of them
  floats over the window: top right at first, and you can drag it anywhere (it remembers where).
  Everyone in the room gets it, whether their own camera is on or not, and it never shows your own
  camera. With several cameras on, it fades over to another person only when their microphone
  picks them up. Its outline is white, and turns green while the person shown is talking. The
  button on it opens the voice window.
- **Picture editor.** Choosing a profile picture or a banner opens an editor: drag to move it inside
  the frame (a circle for the picture, the banner's own shape for a banner), zoom with the slider or
  the mouse wheel, turn it in quarter steps, **Reset** to start over. Click your picture or banner in
  Settings to adjust it again. The file itself is never cut (only its placement is saved), so
  animated GIFs stay animated.
- **One-on-one calls.** Click a person, then **Call**. It rings on their side; no channel needed.
  The two ring sounds are files on the server: `public/sounds/incoming.mp3` plays for the person
  being called and `public/sounds/outgoing.mp3` for the caller while waiting. Replace either file
  (keeping the name) to change the ring for everyone.
- **Friends and direct messages.** Add people by username. Messages sent while someone is
  offline wait for them as unread.
- **Do Not Disturb.** Click your own name (bottom left) to switch between Online and Do not
  disturb, which silences message, friend-request and call sounds. Someone messaging you directly
  sees a note saying so, with a button to ping you anyway. Each person gets one ping per spell of
  Do Not Disturb. The ping button exists only in direct messages, never in server channels.
- **Profiles.** Picture, banner and bio. Pictures and banners can be animated GIFs, or PNG, JPG,
  JFIF, WebP or AVIF.
- **Files.** Up to 200 MB each. Images and GIFs show in the chat, videos and audio play in place,
  everything else is a download link.
- **Photo locations.** Phones record where a photo was taken. The server removes that from every
  uploaded JPEG, PNG and WebP before anyone can download it (the GPS part of the EXIF data, and GPS
  fields in XMP). Everything else in the file stays, including which way up the photo goes. HEIC
  and AVIF files are not changed, and files uploaded before this was added keep their location.
- **Several devices.** One account can be signed in on the computer, the phone and a browser at
  once. Messages and calls reach all of them; voice is on one device at a time, and the others show
  a green strip to switch it over. A call rings on every device and stops on the rest once answered.
- **Calls in the desktop app.** A one-on-one call sits across the top of the conversation with that
  person, with a timer under the pictures. Drag its bottom edge to make it taller or shorter.
- **Timers.** A voice channel with people in it shows how long it has been going, next to its name
  and in the voice window's header; calls show it under the pictures. It counts from when the first
  person joined, as the server saw it, so everyone sees the same time.
- **Themes.** Settings > Appearance: eight ready-made themes (Onyx, the standard true black, plus
  Graphite, Midnight, Forest, Wine, Aurora, Ember and Dusk), your own background and accent colours,
  a fade into a second colour in any direction, and a background picture with a strength slider.
  Changes show at once; Save keeps them. The theme is saved with the account, so it follows you to
  your other devices, and only you see it. In the desktop app the column of servers and the window
  buttons take its colours too.
- **@mentions.** Typing `@` in the message box lists people; arrows or the mouse pick one, Enter or
  Tab puts the name in. The person mentioned sees the message highlighted, a red `@` count on the
  channel, and a notification. Mentions stay plain `@Name` text, so the phone app shows them as
  written.
- **Search.** The box at the top right finds messages in every text channel and in your own direct
  messages (never anyone else's). `from:name` finds one person's; typing `from:` lists people.
  Results open on the right, newest first, with how many each person wrote; click a person to see
  only theirs, and click a message to go to it.
- **Notifications.** New messages and calls pop up as system notifications while you are not
  looking: in the desktop app (from version 1.4) whenever its window is in the background, in a
  browser once you allow it. Settings > Notifications chooses all messages, direct messages and
  mentions only, or off. Do Not Disturb silences them. Clicking one opens that conversation.
- **Idle.** After 20 minutes away you show as Idle, with a yellow moon. In the desktop app, away
  means no key or mouse used anywhere on the computer (so playing a game is not away); in a browser,
  nothing done on the page. Not while in a voice channel or call, and Do Not Disturb stays as it is.
  With several devices signed in, you are idle only once all of them are.
- **What you are playing.** Under your name: "Playing Minecraft", "Listening to Spotify". Your
  profile card shows the details: a game's picture, what it says (such as "Ranked · 7–4") and how
  long you have been playing; a song's cover, artist, album, and the time gone and left. It comes
  from the desktop app (1.4.6 on), two ways:
  - *Any game Discord knows* (from 1.4.7): every 15 seconds the app looks at which programs are
    running and matches them against Discord's public list of about 25,000 games and their program
    names (fetched once a week, kept in the app's folder as `games.json`). This is how most games
    show, since most never say anything themselves. Code: `desktop/games.js`.
  - *Games* that show their status in Discord tell it over a local channel (`discord-ipc-0`, a
    named pipe on Windows, a socket in the temporary folder on a Mac). The app opens the same
    channel, and looks the game's name and pictures up in Discord's public list. Whichever of
    Discord and Umbryx starts first has the channel: if Umbryx does, it passes each game through to
    Discord as well, so both show it; if Discord does, the games tell only Discord until it quits.
    Code: `desktop/presence.js`.
  - *Spotify*: each person clicks Connect Spotify in Settings once. It works through a Spotify
    developer app that a Server Owner sets up (below), and shows what plays on that Spotify account
    anywhere, the phone included, while the desktop app is open. Spotify does not announce pauses or
    skips, so the app asks every 4 to 5 seconds; on Windows it also watches the Spotify app's window
    title (the song while one plays, "Spotify" when paused) and asks the moment it changes. On a
    profile card the song, the album and each artist open in Spotify. Code: `desktop/spotify.js`.

  Settings has two switches (desktop 1.4.8 on): "Show the game I am playing" and "Show what I am
  listening to on Spotify". Pictures load from Discord's and Spotify's own picture servers and
  nowhere else.

  **Setting up Spotify (once, by a Server Owner).** On developer.spotify.com, sign in with a Spotify
  account that has Premium (Spotify requires it of the app's owner), open the Dashboard and create
  an app: any name, Redirect URI `http://127.0.0.1:43117/callback`, and tick Web API. In the app's
  User Management, add each person who will connect (their name and Spotify email; a new app in
  Spotify's Development Mode allows 5). Copy the app's Client ID into Server settings (the pencil
  next to the server's name). The Client ID is not a secret; nothing else is needed.
- **Link previews.** A YouTube video or a post on X (or twitter.com) in a message gets a card under
  it, as in Discord: a video's channel, title and picture, playing in YouTube's own player once
  clicked; a post's author, text, pictures or video, date, replies and likes. The server looks each
  link up (YouTube's oEmbed, X's own embedding service, or FixTweet if that fails) and keeps the
  answer for six hours, so a link many people see is looked up once. Up to three per message.
- **Staying at the newest message.** Someone at the bottom of a chat stays there while pictures,
  videos and previews finish loading; scrolling up lets go, scrolling back down holds on again.
- **Links in bios** can be clicked.
- **Nameplates.** Settings > Nameplate: an animated design (Nebula, Ember, Aurora, Synthwave, Ocean,
  Sakura, Glitch, Gold; drawn in `style.css`, still for anyone who turns animation off in Windows)
  or your own picture, GIF, WebP or short MP4/WebM video, behind your name in the direct messages
  list, the member list and voice channels, fading out towards the name.
- **Display names.** Settings > Display name (optional) is shown in chat, the member list, calls and
  everywhere else instead of the username, as in Discord; profile cards show the username under it.
  The username stays what signing in, @mentions and `from:` searches use (typing @ finds either).
- **Settings** is one page of cards: profile, appearance (colours and the background picture fold
  away), voice and video (with a microphone level meter: live while in voice, or Test), activity,
  and the app (notifications, sounds, and in the desktop app from 1.4.9 zoom, the version, What's new
  and Check for updates). Chips along the top go to each card.
- **Watching a screen share.** Its name and numbers along the top fade with the controls along the
  bottom when the pointer leaves or rests; on your own share, hovering "2 watching" lists who.
- **Noise suppression.** Settings > Noise suppression: *Strong* (the default) runs RNNoise, a small
  neural network made for voices, on your microphone in the page before the sound goes out: fans,
  typing and hum go, the voice stays. Measured here: steady fan noise about 29 dB quieter, and
  about 2.5% of one processor core while the microphone is open. *Standard* is the browser's own;
  *Off* sends the microphone as it is. Files and licences in `server/public/rnnoise`; the page
  needs `'wasm-unsafe-eval'` in its Content-Security-Policy to run it (set in `server.py`), and
  falls back to the plain microphone if it cannot.
- **Screen share sounds.** A short rising sound when a screen share in your voice channel starts
  (yours or someone's), a falling one when it ends, and two quick notes when someone starts
  watching yours. They follow the Sounds switch in Settings.
- **Badges.** On profile cards (not next to names): Umbryx Staff, Server Owner, Early
  Supporter and Umbryx Partner (a white checkmark, which a partnered server also shows next to its
  name at the top of its channel list). Whoever runs the server gives them in `config.json` (see `server/README.md`).
- **Server settings.** A Server Owner sees a pencil next to the server's name in the title strip:
  change the name, picture and banner. The picture shows in the title strip, the browser tab and
  the desktop app's column of servers; the banner sits above the channel list.
- **What's new.** The first time the desktop app opens after an update, a window lists what
  changed (also in the app menu). The notes are `desktop/whats-new.json`, one list per version.
- **Calls on mobile data.** For calls that cannot connect directly, the server can run a TURN
  relay; `server/README.md` ("Calls on mobile data and strict networks") explains the setup.
- **Motion.** Three things move, all briefly: buttons fade their colours on hover and press in
  slightly when clicked (a message's Reply/Pin/Edit buttons fade in); the middle of the window
  fades when you change channel; and notices, the reply bar, upload cards and the "Voice connected"
  panel slide in. Messages, windows and popups appear at once. Windows' "reduce motion" setting
  switches all of it off.
- **Logo font.** The Umbryx name is set in Corbel, which is built into Windows, so nothing needs
  installing. Phones, Macs and Linux fall back to a similar plain font.
- **Logo.** A black cut stone in front of a white corona. The picture is `icon.svg` (in
  `server/public` for the interface, in `desktop` for the app); `python tools/make_icon.py` turns
  the desktop one into `icon.ico` for the exe and the taskbar.

## Screen sharing

Join a voice channel or a call, press **Share screen**, choose the quality, then pick a screen,
window or tab. Others click **Watch stream** on your tile.

- **4K needs a 4K source.** A stream is never upscaled beyond the screen or window you picked.
- **Sound.** Pick a tab or your entire screen and switch on the audio option in the picker.
- **Check the result.** The label on every stream shows the real resolution, frame rate, bitrate
  and codec.
- **GPU encoding.** With the encoder set to **Automatic (GPU first)** the app asks for codecs
  your graphics card encodes (NVENC on NVIDIA) and shows what it found in the share dialog.
  `Umbryx.exe` also asks Windows to run its window on the high-performance graphics chip.
- **HDR screens.** A stream is always SDR. On Windows 11 24H2 or newer, Windows converts a whole
  HDR screen to SDR as it is captured; highlights brighter than SDR white are flattened to white.
  On older Windows a whole HDR screen comes out far too bright, so share the game or app window
  instead, which is converted properly on every version. The desktop app's picker marks HDR
  screens and says which case applies.
- **Group size.** Each viewer gets their own encoded stream, so it suits small groups.

## What is where

| Folder | What is in it |
| --- | --- |
| `server` | The server (`server.py`, `certgen.py`) and the Docker files. Python standard library only. |
| `server/public` | The whole interface: `index.html`, `app.js`, `style.css`, the logo, the emoji list and the two ring sounds. |
| `desktop` | The Windows app's source: `main.js` (the window), `preload.js`, `presence.js`, `games.js` and `spotify.js` (what you are playing), the setup screen and the screen picker. |
| `tools` | Scripts that make the emoji list, the app icons, the Mac app, the logo and ring-sound options, and `publish_update.py`, which offers a new version of the desktop app to everyone. |

- **Theme.** The colours are the variables at the very top of `server/public/style.css`
  (background, lines, text, accent, online green, live red). Change them there and every screen
  follows. The app's own two screens (setup and screen picker) repeat the same variables at the top
  of `desktop/app.css`.
- **Not in a source zip:** `server/data` and `server/config.json`. Those hold the accounts,
  messages, uploads and the server's private key, and belong only on the server.

## Rebuilding the app

The app's source is in the `desktop` folder (it is built with Electron). `desktop\build.bat`
rebuilds it into `%USERPROFILE%\umbryx-build\dist\Umbryx-win32-x64`. It needs Node.js, either on
the PATH or the portable copy in `%USERPROFILE%\umbryx-build\node`.

The interface itself is served by the server, so new features only need the server's files
updated; the app does not have to be rebuilt or sent out again. When the app itself changes,
publish it as an update (see "Desktop app updates") instead of sending the zip around.

## Credits

Umbryx is made by **Jorge** ([vlcno](https://github.com/vlcno)) and **Abby**, with **Claude**
(Anthropic's AI, Claude Opus 5.5 in Claude Code), which wrote the code with them: the server, the website, the
desktop app and the tools. Commits Claude helped with carry a `Co-Authored-By: Claude` line.
