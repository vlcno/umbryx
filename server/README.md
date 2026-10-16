# Umbryx server (Linux / Docker / Portainer)

This folder is the server. It runs on Ubuntu in Docker, and is set up to be deployed as a
Portainer stack. People connect to it with `Umbryx.exe` on Windows, or with any browser.

The server uses only the Python standard library, so the stock `python:3.12-slim` image runs it
directly. There is no image to build and nothing to install.

## Deploy with Portainer

**1. Put the files on the Ubuntu machine.** On the server:

```bash
sudo mkdir -p /opt/umbryx/app /opt/umbryx/data
```

Then copy the `.py` files (`server.py`, `certgen.py`, `p256.py`, `passkeys.py`, `push.py`) and the `public` folder into `/opt/umbryx/app`. From Windows,
in this folder, replace `you@your-server` with your login:

```bash
scp -r *.py public you@your-server:/tmp/
```

and on the server:

```bash
sudo mv /tmp/*.py /tmp/public /opt/umbryx/app/
```

**2. Create the stack.** In Portainer open **Stacks > Add stack**, name it `umbryx`, choose
**Web editor** and paste the contents of `docker-compose.yml`.

**3. Set the address.** Change `UMBRYX_HOSTS` in the pasted text to the address people will use:
the server's IP on your network, a domain name, or both separated by commas.

**4. Deploy the stack,** then open the container's **Logs**. It prints the address to share,
for example `https://192.168.1.50:3443`.

**5. Open the port** if the server has a firewall:

```bash
sudo ufw allow 3443/tcp
```

**6. Connect.** Start `Umbryx.exe` on Windows and type the server's address. In a browser, open
`https://YOUR-SERVER:3443` and accept the certificate warning once (Advanced, then Continue).

## Keeping your existing accounts and messages

Everything the server knows is in its data folder. To carry over what you already have, copy the
contents of this folder's `data` directory into `/opt/umbryx/data` on the server before deploying.
The security certificate is recreated for the new address automatically.

## Updating

Copy the new `.py` files and `public` over the old ones in `/opt/umbryx/app`, then
restart the container in Portainer. Data is not touched.

The server also hands out updates of the desktop app: `tools/publish_update.py` sends a new version,
signed with the publisher's key, and it is kept in `/opt/umbryx/data/updates`. The server refuses
anything that key did not sign, and anything older than what it already offers. Nothing needs setting
up for this.

## Settings

`/opt/umbryx/data/config.json` is created on first start. Restart the container after editing it.

**Badges.** `badges` gives people marks on their profile: `staff` (Umbryx Staff), `owner` (Server
Owner), `early` (Early Supporter) and `partner` (Umbryx Partner). Each key is an account's username (any
capitals) or its id:

```json
"badges": { "Abby": ["staff", "owner"], "SomeFriend": ["early"] }
```

`"admins"` lists who may change the server's name, picture and banner from the app (the pencil next to the
server's name), by username or id: `"admins": ["vlcno", "Abby"]`. Without it, people with the `owner` badge may,
as before. The `owner` badge itself (Server Owner) is for people who run their own Umbryx server, given once you
have checked. `"earlySupporters": true` (the default) gives every new account the Early Supporter badge; set it to
false when the early days are over (those who have it keep it). Names in `badges` and `admins` follow a rename
made in the app, so a name that becomes free again does not hand its badges to whoever takes it next.

Admins can also change the server's name, picture and banner from the app (the pencil next to
the server's name). Those are kept in `serverName`, `serverIcon` and `serverBanner`. `"serverPartner": true`
puts the white Umbryx Partner checkmark next to the server's name (set here, by whoever runs the server). The same dialog
takes the Client ID of a Spotify developer app, for "Listening to Spotify" (`spotifyClientId`; the
main README's "What you are playing" says how to make one).

| Key | Meaning |
| --- | --- |
| `serverName` | Name shown in the app. |
| `password` | If set, people need it to create an account (and to come in as a guest). |
| `inviteOnly` | `true` by default: new accounts start in direct messages until they enter an invite code (admins make them in Server settings). `false` lets them join straight away. |
| `canDeleteStaff` | Accounts (usernames or ids) that may delete anyone's account, Umbryx Staff's included; nobody else may delete theirs. Staff may delete other people's accounts, but not Staff's. |
| `guests` | `true` by default: **Skip for now** on the sign-in screen, for people without an account, who see only the friends they add. `false` turns it off. |
| `hosts` | Same as `UMBRYX_HOSTS`: addresses people use to reach the server. |
| `trustProxy` | Set to `true` only when a reverse proxy sits in front, so sign-in limits apply per visitor. |
| `passkeyDomain` | The domain passkeys belong to, such as `"vlcno.xyz"`: one passkey then works on every address under it (the website, the apps' address) and in the iPhone app. Set it before anyone adds a passkey: passkeys made for another domain stop working when it changes. Empty: the address the page is on (none on an IP address). |
| `appleAppIds` | The iPhone app as Apple names it, `["TEAMID.bundle.id"]`. The server then answers `/.well-known/apple-app-site-association`, which the app needs for passkeys (served at the passkey domain itself) and for invite links that open in it. |
| `apns` | Push notifications to the iPhone app: `{"teamId": "...", "keyId": "...", "keyFile": "apns-key.p8", "bundleId": "...", "sandbox": false}`. Make a push key in your Apple developer account (Keys, Apple Push Notifications service), put the `.p8` file in the data folder (readable by the container's user, and by no one else), and restart. `sandbox: true` only while testing builds run from Xcode. |
| `appAddress` | The address the desktop app should use, when it is not the website's: `"https://app.example.com"`. Apps that came in another way (an IP address) move there by themselves, keeping their sign-ins, once it answers with a trusted certificate and is this same server. Invite links use it too. Empty: apps stay where they are, and links use the website's address. |
| `maxUploadMB` | Largest file that can be uploaded (200 by default). |
| `iceServers` | STUN/TURN servers used to connect people's calls to each other. |
| `httpPort`, `httpsPort` | Leave these alone in Docker; change the left side of `ports:` in the stack instead. |

## Good to know

- **Why https and the warning.** Browsers only allow microphones and screen capture on secure
  pages. The server makes its own certificate, which browsers warn about once. `Umbryx.exe` asks
  once whether to trust the server and remembers the answer.
- **A real certificate.** If you run a reverse proxy with a domain (Nginx Proxy Manager, Traefik,
  Caddy), point it at port 3000 with WebSocket support switched on, set `trustProxy` to `true`,
  and people can use `https://your-domain` with no warning at all.
- **Voice and screen share do not pass through the server.** They travel directly between
  people's computers, so the server needs very little CPU and bandwidth. If a call cannot connect
  on mobile data or a strict network, set up the TURN relay (below).
- **One account on several devices.** Anyone can be signed in on their computer, phone and browser
  at once; messages, calls and pings reach all of them. Voice is on one device at a time. While you
  are in a voice channel or call, your other devices show a green strip ("Connected to Lounge on
  another device"); clicking or tapping it moves you there: the other device drops out with a note
  saying so, and the others in the room
  reconnect to the new device within a second or two, without the leave and join sounds. A call rings on all your devices, and
  answering on one stops the rest. Calling from one device shows the call on the others without
  ringing them. Devices running an older Umbryx still connect, and simply do not show the strip.
- **Outside your home network.** Forward TCP port 3443 on your router to the server, or put
  everyone on a private network such as Tailscale. Set a `password` before exposing it.

## Calls on mobile data and strict networks (TURN)

Calls go straight from one person's device to another's. On mobile data and on strict office or
school networks that often cannot happen, and the call sits on "Connecting…". A TURN relay fixes
that by passing the call through your server when a direct path fails. `docker-compose.yml`
includes one (the `turn` service, coturn). It only carries calls that need it.

**1. Pick a password** for the relay. On the server, this prints a random one:

```bash
openssl rand -hex 16
```

**2. Set three values** for the stack. In Portainer, open the stack, scroll to **Environment
variables** and add:

| Name | Value |
| --- | --- |
| `TURN_PASSWORD` | the password from step 1 |
| `TURN_PUBLIC_IP` | your public address, the one people outside your home reach you at |
| `TURN_LOCAL_IP` | the server's address on your network (`hostname -I` shows it first) |

Make sure the stack's editor contains the `turn:` service from `docker-compose.yml`, then
**Update the stack**.

**3. Forward these ports** on your router to the server, alongside 3443:

| Port | Protocol | What for |
| --- | --- | --- |
| 3478 | UDP and TCP | reaching the relay |
| 49160–49260 | UDP | the relayed calls themselves |

If the server has a firewall, open the same ports there:

```bash
sudo ufw allow 3478 && sudo ufw allow 49160:49260/udp
```

**4. Tell the server about the relay.** Add an entry to `iceServers` in `config.json`, using your
public address and the password from step 1, and keep the STUN entry that is already there:

```json
"iceServers": [
  {"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]},
  {"urls": ["turn:YOUR-PUBLIC-IP:3478?transport=udp", "turn:YOUR-PUBLIC-IP:3478?transport=tcp"],
   "username": "umbryx", "credential": "YOUR-TURN-PASSWORD"}
]
```

Restart the `umbryx` container. People pick up the new setting the next time they open the app
or press Ctrl+R.

Good to know:

- The relay password reaches every signed-in device, because that is how a device uses the relay.
  Anyone with an account could in principle use your relay, so keep sign-ups closed with
  `password` if the server is reachable from the internet.
- The relay refuses to forward into your home network, so it cannot be used to reach other
  machines there.
- If your public address changes (many home connections get a new one now and then), update
  `TURN_PUBLIC_IP` and `iceServers` to match.

## Without Docker

```bash
./start.sh
```

runs the same server directly with Python 3.9 or newer (`start.bat` does the same on Windows,
which is handy for trying things out locally).
