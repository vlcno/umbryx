#!/usr/bin/env python3
"""Umbryx: a small self-hosted voice, chat and screen-share server.

Standard library only, so there is nothing to install: run `python server.py`
and open the address it prints. Voice and screen share travel directly
between browsers over WebRTC; this process serves the web app, keeps
accounts, friends and chat history, and relays the connection setup messages.
"""
import argparse
import asyncio
import base64
import calendar
import contextlib
import hashlib
import hmac
import html
import ipaddress
import json
import os
import re
import secrets
import socket
import ssl
import struct
import sys
import time
import traceback
import urllib.request
import zlib
from collections import deque
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

import certgen
import p256
import passkeys
import push

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
CONFIG_FILE = ROOT / "config.json"
# Set by use_data_dir() before anything is read or written.
DATA = UPLOADS = MESSAGES = DMS = UPDATES = None

DEFAULTS = {
    "serverName": "Umbryx",
    "httpPort": 3000,
    "httpsPort": 3443,
    "password": "",
    "autoLogin": "",
    "hosts": [],
    "trustProxy": False,
    "maxUploadMB": 200,
    # Badges on people's profiles, given by whoever runs the server: {"Abby": ["staff", "owner"]}. The key is
    # an account's name (or its id); the badges are any of BADGES. Restart the server after changing it.
    "badges": {},
    # Every account made while this is on gets the Early Supporter badge, and keeps it after it is turned off.
    "earlySupporters": True,
    # New accounts start in direct messages, like guests with a password, until they have an invite code: one typed
    # when making the account, or later. Admins make the codes (Server settings). False: accounts join straight away.
    "inviteOnly": True,
    # A line in the first text channel when someone joins the server ("X joined the party."), as in Discord.
    "joinMessages": True,
    # Accounts (usernames or ids) that may delete anyone's account, Staff's included, and whose own accounts nobody
    # else may delete. Umbryx Staff may delete other people's accounts, but not Staff's.
    "canDeleteStaff": [],
    # Who may change the server's name, picture and banner (usernames or ids). Left out, it is those with the Server
    # Owner badge, as it was before the badge came to mean "runs their own Umbryx server".
    # The server's own picture and banner (set from the app by an admin).
    "serverIcon": "",
    "serverBanner": "",
    # A partnered server shows a checkmark badge next to its name. Set by whoever runs the server; restart after.
    "serverPartner": False,
    # The Client ID of a Spotify developer app, for "Listening to Spotify" (set in Server settings; see README).
    "spotifyClientId": "",
    # The address the desktop app should use for this server, when that is not the one people type for the website:
    # "https://app.example.com". Apps that came in another way (an IP address) move to it by themselves, keeping their
    # sign-ins, once it answers with a trusted certificate. Empty: apps stay where they are.
    "appAddress": "",
    # Passkeys belong to a domain: with "vlcno.xyz", one passkey works on every address under it (umbryx.vlcno.xyz,
    # us.vlcno.xyz) and in the iPhone app. Empty: the address the page is on (none on an IP address: browsers refuse).
    "passkeyDomain": "",
    # The iPhone app as Apple names it, "TEAMID.bundle.id": its passkeys and links (/.well-known/apple-app-site-association).
    "appleAppIds": [],
    # Push notifications to the iPhone app through Apple: the developer account's team id, the push key's id and its
    # file (a .p8 in the data folder: secret, never shared), the app's bundle id, and sandbox for builds from Xcode.
    "apns": {"teamId": "", "keyId": "", "keyFile": "apns-key.p8", "bundleId": "", "sandbox": False},
    "iceServers": [
        {"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]}
    ],
}
DEFAULT_CHANNELS = [
    {"id": "general", "name": "general", "type": "text"},
    {"id": "media", "name": "media", "type": "text"},
    {"id": "lounge", "name": "Lounge", "type": "voice"},
    {"id": "stream-room", "name": "Stream Room", "type": "voice"},
]

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_WS_MESSAGE = 1 << 20          # SDP offers with many tracks can be tens of KB
MAX_WS_BACKLOG = 8 << 20          # drop clients that stop reading
HISTORY_PAGE = 60
MAX_CHANNELS = 100
MAX_PINS = 50
MAX_EMOJIS = 300
MAX_FAVORITES = 300
PBKDF2_ROUNDS = 240_000
RING_SECONDS = 40
JOIN_KINDS = 12      # how many join greetings the apps know (the page's JOIN_TEXTS); the server picks one
MAX_BLOCKED = 1000   # how many people one account can block
# Why someone is reported (see on_report), and how a push to the admins words it.
REPORT_REASONS = {"spam": "Spam", "harassment": "Harassment or bullying", "hate": "Hate speech",
                  "sexual": "Sexual content", "violence": "Violence or threats", "self-harm": "Self-harm",
                  "other": "Something else"}
REPORTS_PER_HOUR = 10   # per account
REPORT_KEEP_DAYS = 90   # closed reports are kept this long, then go
# The desktop app's updates. A version is only accepted, and the app only installs it, when its description is
# signed with the publisher's private key; this is the public half, which can check a signature but not make one.
UPDATE_KEY = base64.b64decode("hOjCJhEHyp0qFTcFaDyoitsgiT/fAMSnUJp3em6YgRA=")
UPDATE_FILE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")
UPDATE_VERSION = re.compile(r"^\d{1,4}\.\d{1,4}\.\d{1,4}$")
MAX_UPDATE_BYTES = 600 << 20

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json",
    ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",   # noise suppression (public/rnnoise)
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",   # the ring sounds in public/sounds
}
# Uploads the browser may show in place. Everything else is offered as a download.
INLINE_TYPES = {
    ".png": "image/png", ".apng": "image/apng", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".jfif": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp",
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mkv": "video/x-matroska", ".ogv": "video/ogg",
    ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4",
    ".aac": "audio/aac", ".flac": "audio/flac",
}
IMAGE_SUFFIXES = {ext for ext, kind in INLINE_TYPES.items() if kind.startswith("image/")}
STATUS_TEXT = {
    101: "Switching Protocols", 200: "OK", 206: "Partial Content", 400: "Bad Request", 401: "Unauthorized",
    403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 411: "Length Required",
    413: "Payload Too Large", 416: "Range Not Satisfiable", 500: "Internal Server Error",
}
# Pictures of what people are playing load from Discord's and Spotify's picture servers (see clean_activity), and
# link previews from YouTube's and X's (see fetch_embed); YouTube videos play in YouTube's own player. The page's
# scripts may run WebAssembly: Strong noise suppression is RNNoise compiled to it (public/rnnoise).
APP_CSP = (
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ws: wss:; "
    "img-src 'self' data: blob: https://cdn.discordapp.com https://i.scdn.co https://i.ytimg.com https://pbs.twimg.com; "
    "media-src 'self' blob: https://video.twimg.com; frame-src https://www.youtube-nocookie.com; "
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
)
UPLOAD_URL = re.compile(r"^/uploads/([a-f0-9]{24}(?:\.[a-z0-9]{1,8})?)$")
CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f\u200b-\u200f\u2028-\u202e]")
USERNAME = re.compile(r"^\w[\w .\-]{0,22}\w$")
EMOJI_NAME = re.compile(r"^[a-z0-9_]{2,32}$")
NAME_COLOR = re.compile(r"^#[0-9a-f]{6}$")
NOTE_MINUTES = (0, 30, 60, 240, 1440)   # how long a custom status may last; 0 keeps it until it is changed
THEME_PRESET = re.compile(r"^[a-z0-9-]{1,24}$")
BADGES = ("staff", "owner", "early", "partner")   # Umbryx Staff (the people who make it), Server Owner, Early Supporter, Umbryx Partner
MAX_SEARCH_RESULTS = 60
SEARCH_WORDS = re.compile(r"[\w']+")         # a message's words, for search (whole words, not pieces of them)
SEARCH_HAS = ("image", "video", "file", "link")
LINK_IN_TEXT = re.compile(r"\bhttps?://\S", re.I)
ACTIVITY_KINDS = (0, 2, 3, 5)   # Discord's: playing, listening to, watching, competing in
ACTIVITY_SOURCES = ("game", "spotify")
ACTIVITY_PICTURE = re.compile(r"^(?:https://cdn\.discordapp\.com/app-(?:icons|assets)/\d{5,25}/[A-Za-z0-9_]{1,64}\.png(?:\?size=\d{2,4})?"
                              r"|https://i\.scdn\.co/image/[a-f0-9]{40})$")
MAX_ACTIVITY_MS = 31 * 24 * 3600 * 1000
SPOTIFY_CLIENT_ID = re.compile(r"^[0-9a-f]{32}$")
# Nameplates (behind a name in lists): one of these designs, drawn by the app, or an uploaded picture or short video.
PLATES = ("nebula", "ember", "aurora", "synth", "ocean", "sakura", "glitch", "gold")
PLATE_VIDEO = {".mp4", ".m4v", ".webm"}
SPOTIFY_LINK = re.compile(r"^https://open\.spotify\.com/(?:track|album|artist|episode|show)/[A-Za-z0-9]{22}$")
# Link previews (fetch_embed): a YouTube video, or a post on X (also written as twitter.com and the fx/vx mirrors).
EMBED_YOUTUBE = re.compile(r"^https?://(?:www\.|m\.|music\.)?(?:youtube\.com/(?:watch\?(?:[^#\s]*&)?v=|(shorts|live|embed)/)|youtu\.be/)"
                           r"([A-Za-z0-9_-]{11})(?:[?&#/][^\s]*)?$")
EMBED_X = re.compile(r"^https?://(?:www\.|mobile\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx)\.com/([A-Za-z0-9_]{1,15})/status(?:es)?/(\d{1,25})"
                     r"(?:[/?#][^\s]*)?$")
X_PICTURE = re.compile(r"^https://pbs\.twimg\.com/[A-Za-z0-9_./-]{1,200}(?:\?[A-Za-z0-9=&_.-]{0,80})?$")
X_VIDEO = re.compile(r"^https://video\.twimg\.com/[A-Za-z0-9_./-]{1,250}\.mp4(?:\?[A-Za-z0-9=&_.-]{0,80})?$")
EMBED_KEEP = 6 * 3600        # seconds a looked-up preview is kept
EMBED_RETRY = 10 * 60        # ...or a failed lookup before trying again
MAX_EMBED_ASKS = 60          # per connection per minute
NO_VOICE = {"voice": None, "muted": False, "deafened": False, "sharing": False, "camera": False}
DEVICES = ("desktop", "web", "mobile")   # what someone can be on: the desktop app, the website, the phone app


def device_of(agent):
    """What a connection comes from, by its User-Agent, until it says so itself when it signs in (on_auth): the
    desktop app (a browser's agent ending in Umbryx/<version>, see desktop/main.js), a browser, or the phone app
    (Apple's networking, no browser in it)."""
    agent = agent or ""
    if "Mozilla/" in agent:
        return "desktop" if " Umbryx/" in agent or "Electron/" in agent else "web"
    return "mobile" if "CFNetwork" in agent or "Darwin/" in agent else "web"
# What a guest may not do: everything to do with the server's channels, and changing the server.
GUEST_BARRED = {"chat", "history", "server-update", "emoji-add", "emoji-remove", "channel-create", "channel-delete", "channel-rename"}
GUEST_BARRED_WHY = {"emoji-add": "Custom emoji belong to the server: you can add them once you are in it."}
INVITE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"   # no 0/O, 1/I/L: codes are read out and typed
INVITE_USES = (1, 5, 25, 0)    # 0: no limit
INVITE_DAYS = (1, 7, 30, 0)    # 0: never runs out
MAX_INVITES = 100
DELETED_NAME = "Deleted user"  # what a deleted account's messages show as
LOOPBACK = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]"}
PROXY_HEADERS = ("x-forwarded-for", "x-forwarded-host", "forwarded", "x-real-ip", "cf-connecting-ip")


class Kick(Exception):
    """Raised by a handler to close the connection."""


def use_data_dir(path):
    global DATA, UPLOADS, MESSAGES, DMS, UPDATES
    DATA = Path(path).resolve()
    UPLOADS, MESSAGES, DMS, UPDATES = DATA / "uploads", DATA / "messages", DATA / "dms", DATA / "updates"
    for folder in (DATA, UPLOADS, MESSAGES, DMS, UPDATES):
        folder.mkdir(parents=True, exist_ok=True)


def log(text):
    print("  [%s] %s" % (time.strftime("%H:%M:%S"), text), flush=True)


def dumps(obj):
    # ensure_ascii keeps lone surrogates from browsers encodable.
    return json.dumps(obj, separators=(",", ":"))


def write_json(path, obj):
    """Replace a file in one step so a crash cannot leave it half written."""
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(obj, indent=1), "utf-8")
    os.replace(temp, path)


def clean_text(value, limit):
    text = CONTROL_CHARS.sub(" ", str(value or ""))
    return re.sub(r"\s+", " ", text).strip()[:limit].strip()


def clean_block(value, limit):
    """Like clean_text, but keeps line breaks."""
    text = CONTROL_CHARS.sub(lambda hit: "\n" if hit.group() == "\n" else "", str(value or ""))
    return text[:limit].strip()


def profile_image(value):
    """Accept only an image that was uploaded to this server (profile picture or banner)."""
    hit = UPLOAD_URL.match(str(value or ""))
    if not hit:
        return ""
    path = UPLOADS / hit.group(1)
    return "/uploads/" + hit.group(1) if path.suffix in IMAGE_SUFFIXES and path.is_file() else ""


def clean_activity(raw):
    """One thing someone is doing, as their desktop app heard it (a game through Discord's channel, or Spotify),
    or None. Pictures only from Discord's and Spotify's picture servers; times as how long ago it started and how
    long is left, in milliseconds, so a computer whose clock is off still shows the right ones."""
    if not isinstance(raw, dict):
        return None
    name = clean_text(raw.get("name"), 64)
    if not name:
        return None
    kind = raw.get("kind")
    out = {"source": raw.get("source") if raw.get("source") in ACTIVITY_SOURCES else "game", "name": name,
           "kind": kind if kind in ACTIVITY_KINDS and not isinstance(kind, bool) else 0}
    for key in ("details", "state", "album", "imageText", "smallText"):
        out[key] = clean_text(raw.get(key), 128)
    # A song's links to Spotify: the song itself, its album, and each artist.
    out["trackUrl"], out["albumUrl"] = spotify_link(raw.get("trackUrl")), spotify_link(raw.get("albumUrl"))
    artists = raw.get("artists") if isinstance(raw.get("artists"), list) else []
    out["artists"] = [{"name": clean_text(a.get("name"), 64), "url": spotify_link(a.get("url"))}
                      for a in artists[:8] if isinstance(a, dict) and clean_text(a.get("name"), 64)]
    for key in ("icon", "image", "small"):
        url = str(raw.get(key) or "")
        out[key] = url if len(url) < 200 and ACTIVITY_PICTURE.match(url) else ""
    party = raw.get("party")
    good_party = (isinstance(party, list) and len(party) == 2
                  and all(isinstance(n, int) and not isinstance(n, bool) and 0 <= n <= 100000 for n in party) and party[0] <= party[1])
    out["party"] = party if good_party else None
    out["elapsed"] = _number(raw.get("elapsed"), 0, MAX_ACTIVITY_MS)
    out["left"] = _number(raw.get("left"), 0, MAX_ACTIVITY_MS)
    return out


def clean_plate(value):
    """A nameplate: a design's name, or an upload on this server that is a picture or a short video; else none."""
    value = str(value or "")
    if value in PLATES:
        return value
    hit = UPLOAD_URL.match(value)
    if not hit:
        return ""
    path = UPLOADS / hit.group(1)
    return "/uploads/" + hit.group(1) if (path.suffix in IMAGE_SUFFIXES or path.suffix in PLATE_VIDEO) and path.is_file() else ""


def spotify_link(value):
    url = str(value or "")
    return url if SPOTIFY_LINK.match(url) else ""


def same_activities(a, b):
    """The same things, give or take a couple of seconds in their times (each report measures them afresh)."""
    if len(a) != len(b):
        return False
    for x, y in zip(a, b):
        if {k: v for k, v in x.items() if k not in ("since", "until")} != {k: v for k, v in y.items() if k not in ("since", "until")}:
            return False
        for key in ("since", "until"):
            if (x[key] is None) != (y[key] is None) or (x[key] is not None and abs(x[key] - y[key]) > 2):
                return False
    return True


def embed_target(url):
    """What a link previews as: ("youtube", id), ("x", id), or None. Extra details (a YouTube start time, a Short
    standing upright) come separately, since they differ between links to the same video."""
    hit = EMBED_YOUTUBE.match(url)
    if hit:
        return ("youtube", hit.group(2))
    hit = EMBED_X.match(url)
    if hit:
        return ("x", hit.group(2))
    return None


def youtube_start(url):
    """Seconds into the video a link starts at (t=90, t=1m30s, start=90), or 0."""
    query = parse_qs(urlsplit(url).query)
    raw = (query.get("t") or query.get("start") or [""])[0]
    hit = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?", raw)
    if not raw or not hit:
        return 0
    h, m, s = (int(x or 0) for x in hit.groups())
    return min(h * 3600 + m * 60 + s, 24 * 3600)


def _get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; Umbryx link previews)", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=8) as res:
        return json.loads(res.read(4 << 20).decode("utf-8"))


def _youtube(vid):
    about = _get_json("https://www.youtube.com/oembed?format=json&url=" + quote("https://www.youtube.com/watch?v=" + vid, safe=""))
    channel = str(about.get("author_url") or "")
    return {"kind": "youtube", "id": vid, "url": "https://www.youtube.com/watch?v=" + vid,
            "title": clean_text(about.get("title"), 200), "author": clean_text(about.get("author_name"), 100),
            "authorUrl": channel if re.match(r"^https://www\.youtube\.com/[@A-Za-z0-9_./-]{1,100}$", channel) else ""}


def _x_text(post):
    """A post's words, without the trailing links to its own pictures, with short t.co links written out."""
    text = str(post.get("text") or "")
    lo, hi = (post.get("display_text_range") or [0, len(text)])[:2]
    text = text[lo:hi] if isinstance(lo, int) and isinstance(hi, int) else text
    entities = post.get("entities") or {}
    for link in entities.get("urls") or []:
        if isinstance(link, dict) and link.get("url") and str(link.get("expanded_url") or "").startswith("http"):
            text = text.replace(link["url"], link["expanded_url"])
    for media in entities.get("media") or []:   # the post's own pictures show underneath instead
        if isinstance(media, dict) and media.get("url"):
            text = text.replace(media["url"], "")
    return clean_block(html.unescape(text), 1000)


def _x(tid):
    """A post on X, from X's own embedding service, or (if that fails) from the FixTweet service."""
    try:
        post = _get_json("https://cdn.syndication.twimg.com/tweet-result?id=%s&lang=en&token=x" % tid)
        user = post.get("user") or {}
        out = {"text": _x_text(post), "name": user.get("name"), "handle": user.get("screen_name"),
               "avatar": str(user.get("profile_image_url_https") or "").replace("_normal.", "_bigger."),
               "likes": post.get("favorite_count"), "replies": post.get("conversation_count"), "reposts": None,
               "date": post.get("created_at"), "photos": [], "video": None}
        for m in post.get("mediaDetails") or []:
            info = m.get("original_info") or {}
            if m.get("type") == "photo":
                out["photos"].append({"url": m.get("media_url_https"), "w": info.get("width"), "h": info.get("height")})
            elif m.get("type") in ("video", "animated_gif") and not out["video"]:
                mp4 = [v for v in (m.get("video_info") or {}).get("variants") or [] if v.get("content_type") == "video/mp4"]
                if mp4:
                    best = max(mp4, key=lambda v: v.get("bitrate") or 0)
                    out["video"] = {"url": best.get("url"), "poster": m.get("media_url_https"), "w": info.get("width"),
                                    "h": info.get("height"), "gif": m.get("type") == "animated_gif"}
        if not out["handle"]:
            raise ValueError("no post")
    except Exception:
        post = (_get_json("https://api.fxtwitter.com/status/%s" % tid) or {}).get("tweet") or {}
        author, media = post.get("author") or {}, post.get("media") or {}
        out = {"text": clean_block(str(post.get("text") or ""), 1000), "name": author.get("name"), "handle": author.get("screen_name"),
               "avatar": author.get("avatar_url"), "likes": post.get("likes"), "replies": post.get("replies"),
               "reposts": post.get("retweets"), "date": (post.get("created_timestamp") or 0) * 1000,
               "photos": [{"url": p.get("url"), "w": p.get("width"), "h": p.get("height")} for p in media.get("photos") or []],
               "video": None}
        videos = media.get("videos") or []
        if videos:
            v = videos[0]
            out["video"] = {"url": v.get("url"), "poster": v.get("thumbnail_url"), "w": v.get("width"), "h": v.get("height"), "gif": v.get("type") == "gif"}
    handle = str(out["handle"] or "")
    if not re.fullmatch(r"[A-Za-z0-9_]{1,15}", handle):
        return None
    date = out["date"]
    if isinstance(date, str):
        with contextlib.suppress(ValueError):
            date = calendar.timegm(time.strptime(date[:19], "%Y-%m-%dT%H:%M:%S")) * 1000   # X gives UTC
    size = lambda v: _number(v, 1, 20000)
    photos = [{"url": p["url"], "w": size(p.get("w")), "h": size(p.get("h"))} for p in out["photos"]
              if isinstance(p.get("url"), str) and X_PICTURE.match(p["url"])][:4]
    video = out["video"]
    if video and not (isinstance(video.get("url"), str) and X_VIDEO.match(video["url"])):
        video = None
    if video:
        poster = str(video.get("poster") or "")
        video = {"url": video["url"], "poster": poster if X_PICTURE.match(poster) else "", "w": size(video.get("w")),
                 "h": size(video.get("h")), "gif": bool(video.get("gif"))}
    avatar = str(out["avatar"] or "")
    return {"kind": "x", "id": tid, "url": "https://x.com/%s/status/%s" % (handle, tid), "text": out["text"],
            "name": clean_text(out["name"], 60) or handle, "handle": handle, "avatar": avatar if X_PICTURE.match(avatar) else "",
            "likes": _number(out["likes"], 0, 10 ** 12), "replies": _number(out["replies"], 0, 10 ** 12),
            "reposts": _number(out["reposts"], 0, 10 ** 12), "date": date if isinstance(date, int) and date > 0 else None,
            "photos": photos, "video": video}


def fetch_embed(kind, ident):
    """Looks a link preview up (this waits on the network, so it runs on a worker thread). None if it cannot."""
    try:
        return _youtube(ident) if kind == "youtube" else _x(ident)
    except Exception as err:
        log("link preview %s %s: %s" % (kind, ident, err))
        return None


def _number(value, low, high):
    """value as a whole number between low and high, or None if it is not a number at all."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or abs(value) > 1e9:
        return None
    return max(low, min(high, int(value)))


def clean_theme(value):
    """A person's colour theme as the app sends it, keeping only what is valid. None is the standard look.

    bg and accent are the two colours everything else is worked out from, with text the colour of the writing if
    they chose one; gradient fades bg into a second colour; image is a picture behind everything, shown at
    imageOpacity percent."""
    if not isinstance(value, dict):
        return None

    def color(v):
        text = str(v or "").lower()
        return text if NAME_COLOR.match(text) else ""

    preset = str(value.get("preset") or "")
    theme = {
        "preset": preset if THEME_PRESET.match(preset) else "",
        "bg": color(value.get("bg")) or "#000000",
        "accent": color(value.get("accent")) or "#f2b24a",
    }
    if color(value.get("text")):
        theme["text"] = color(value.get("text"))
    gradient = value.get("gradient")
    if isinstance(gradient, dict) and color(gradient.get("to")):
        angle = _number(gradient.get("angle"), -100000, 100000)
        theme["gradient"] = {"to": color(gradient["to"]), "angle": (angle if angle is not None else 160) % 360}
    image = profile_image(value.get("image"))
    if image:
        opacity = _number(value.get("imageOpacity"), 0, 100)
        theme["image"] = image
        theme["imageOpacity"] = 45 if opacity is None else opacity
    return theme


def avatar_fit(value):
    """Where a profile picture sits inside its circle, as chosen in the picture editor.

    Size (w, h) and centre (x, y) are percentages of the circle, r is a turn in quarter steps. The file itself
    is never cut, so an animated picture stays animated. Anything out of range means "no placement".
    """
    if not isinstance(value, dict):
        return None
    try:
        w, h, x, y = (float(value[key]) for key in ("w", "h", "x", "y"))
        r = int(value.get("r", 0))
    except (KeyError, TypeError, ValueError, OverflowError):
        return None
    if not (20 <= w <= 6000 and 20 <= h <= 6000 and -3000 <= x <= 3100 and -3000 <= y <= 3100) or r not in (0, 90, 180, 270):
        return None
    return {"w": round(w, 2), "h": round(h, 2), "x": round(x, 2), "y": round(y, 2), "r": r}


# --- photo locations ---------------------------------------------------------------------------------------
#
# Phones write where a photo was taken into the file. Uploads lose that before anyone can download them:
# the GPS block of the EXIF data in JPEG, PNG (eXIf) and WebP files, and GPS fields in XMP. Everything else
# stays, Orientation above all, or photos would show sideways. Nothing is moved inside the file: the GPS data
# is overwritten in place, so every other offset in it stays valid. HEIC and AVIF are left as they are.

EXIF_TYPE_SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4}
GPS_IFD_TAG = 0x8825
XMP_GPS = re.compile(
    rb"\s(?:exif|exifEX):GPS[A-Za-z]+\s*=\s*(?:\"[^\"]*\"|'[^']*')"            # exif:GPSLatitude="..."
    rb"|<((?:exif|exifEX):GPS[A-Za-z]+)\b[^>]*?/>"                             # <exif:GPSLatitude/>
    rb"|<((?:exif|exifEX):GPS[A-Za-z]+)\b[^>]*>.*?</\2\s*>", re.S)             # <exif:GPSLatitude>...</...>


def remove_exif_gps(tiff):
    """Blank the GPS block of an EXIF blob (TIFF layout) in place. Returns True if there was one."""
    order = {b"II": "<", b"MM": ">"}.get(bytes(tiff[:2]))
    if not order or len(tiff) < 8 or struct.unpack_from(order + "H", tiff, 2)[0] != 42:
        return False
    first = struct.unpack_from(order + "I", tiff, 4)[0]
    if first < 8 or first + 2 > len(tiff):
        return False
    count = struct.unpack_from(order + "H", tiff, first)[0]
    end = first + 2 + 12 * count               # just past the last entry; the next-directory pointer follows
    if end + 4 > len(tiff):
        return False
    entries = [first + 2 + 12 * i for i in range(count)]
    entry = next((e for e in entries if struct.unpack_from(order + "H", tiff, e)[0] == GPS_IFD_TAG), None)
    if entry is None:
        return False
    gps = struct.unpack_from(order + "I", tiff, entry + 8)[0]
    if 8 <= gps and gps + 2 <= len(tiff):
        size = struct.unpack_from(order + "H", tiff, gps)[0]
        gps_end = gps + 2 + 12 * size + 4
        if gps_end <= len(tiff):
            for e in range(gps + 2, gps + 2 + 12 * size, 12):   # values too long to sit in the entry itself
                kind, n = struct.unpack_from(order + "HI", tiff, e + 2)
                length = EXIF_TYPE_SIZES.get(kind, 0) * n
                if length > 4:
                    at = struct.unpack_from(order + "I", tiff, e + 8)[0]
                    if 8 <= at and at + length <= len(tiff):
                        tiff[at:at + length] = bytes(length)
            tiff[gps:gps_end] = bytes(gps_end - gps)
    # Take the pointer to the GPS block out of the first directory: the entries after it move up one place
    # and the next-directory pointer follows them. The freed 12 bytes become zeros.
    following = bytes(tiff[end:end + 4])
    tiff[entry:end - 12] = tiff[entry + 12:end]
    tiff[end - 12:end - 8] = following
    tiff[end - 8:end + 4] = bytes(12)
    struct.pack_into(order + "H", tiff, first, count - 1)
    return True


def remove_exif_block_gps(data):
    """EXIF as stored in a file: a TIFF blob, sometimes behind an "Exif\0\0" header. Edits data in place."""
    skip = 6 if data[:6] == b"Exif\x00\x00" else 0
    tiff = bytearray(data[skip:])
    if not remove_exif_gps(tiff):
        return False
    data[skip:] = tiff
    return True


def remove_xmp_gps(data, start=0):
    """Overwrite GPS fields in an XMP packet with spaces, which keeps the XML valid and its length the same."""
    spans = [hit.span() for hit in XMP_GPS.finditer(bytes(data), start)]
    for a, b in spans:
        data[a:b] = b" " * (b - a)
    return bool(spans)


def _strip_jpeg(f):
    removed = False
    f.seek(2)
    while True:
        marker = f.read(2)
        if len(marker) < 2 or marker[0] != 0xFF:
            break
        kind = marker[1]
        if kind == 0xFF:            # fill byte before a marker
            f.seek(-1, 1)
            continue
        if kind == 0x01 or 0xD0 <= kind <= 0xD8:
            continue                # markers without a length
        if kind in (0xDA, 0xD9):    # the image data starts: no more metadata after this
            break
        raw = f.read(2)
        if len(raw) < 2 or int.from_bytes(raw, "big") < 2:
            break
        size = int.from_bytes(raw, "big") - 2
        start = f.tell()
        if kind == 0xE1:            # APP1: EXIF or XMP
            data = bytearray(f.read(size))
            changed = False
            if data.startswith(b"Exif\x00\x00"):
                changed = remove_exif_block_gps(data)
            elif data.startswith(b"http://ns.adobe.com/xap/1.0/\x00"):
                changed = remove_xmp_gps(data, 29)
            if changed:
                f.seek(start)
                f.write(data)
                removed = True
        f.seek(start + size)
    return removed


def _strip_png(f):
    removed = False
    f.seek(8)
    while True:
        head = f.read(8)
        if len(head) < 8:
            break
        length, kind = struct.unpack(">I4s", head)
        start = f.tell()
        if kind in (b"eXIf", b"iTXt") and length <= 32 << 20:
            data = bytearray(f.read(length))
            changed = False
            if kind == b"eXIf":
                changed = remove_exif_block_gps(data)
            elif data.startswith(b"XML:com.adobe.xmp\x00\x00"):   # keyword, then "not compressed"
                changed = remove_xmp_gps(data, 19)
            if changed:
                f.seek(start)
                f.write(data)
                f.write(struct.pack(">I", zlib.crc32(kind + bytes(data)) & 0xFFFFFFFF))
                removed = True
        if kind == b"IEND":
            break
        f.seek(start + length + 4)
    return removed


def _strip_webp(f):
    removed = False
    f.seek(4)
    total = int.from_bytes(f.read(4), "little") + 8
    at = 12
    while at + 8 <= total:
        f.seek(at)
        head = f.read(8)
        if len(head) < 8:
            break
        kind, size = head[:4], int.from_bytes(head[4:], "little")
        if kind in (b"EXIF", b"XMP ") and size <= 32 << 20:
            data = bytearray(f.read(size))
            changed = remove_exif_block_gps(data) if kind == b"EXIF" else remove_xmp_gps(data)
            if changed:
                f.seek(at + 8)
                f.write(data)
                removed = True
        at += 8 + size + (size & 1)
    return removed


def strip_location(path):
    """Remove where a photo was taken from an uploaded picture, in place. True if a location was found.

    The file type is recognised from its first bytes, not its name. A file that cannot be read as one of these
    types is left exactly as it is.
    """
    try:
        with open(path, "r+b") as f:
            magic = f.read(12)
            if magic[:2] == b"\xff\xd8":
                return _strip_jpeg(f)
            if magic[:8] == b"\x89PNG\r\n\x1a\n":
                return _strip_png(f)
            if magic[:4] == b"RIFF" and magic[8:12] == b"WEBP":
                return _strip_webp(f)
    except (OSError, struct.error, ValueError) as err:
        log("could not check %s for a photo location: %s" % (Path(path).name, err))
    return False


# ---------- signatures on desktop app updates (Ed25519, as in RFC 8032) ----------
# Only checking is needed here. Python's standard library has no Ed25519, so this is the RFC's own method.

ED_P = 2 ** 255 - 19
ED_Q = 2 ** 252 + 27742317777372353535851937790883648493
ED_D = -121665 * pow(121666, ED_P - 2, ED_P) % ED_P
ED_SQRT_M1 = pow(2, (ED_P - 1) // 4, ED_P)


def _ed_add(a, b):
    p = ED_P
    x = (a[1] - a[0]) * (b[1] - b[0]) % p
    y = (a[1] + a[0]) * (b[1] + b[0]) % p
    c = 2 * a[3] * b[3] * ED_D % p
    d = 2 * a[2] * b[2] % p
    e, f, g, h = y - x, d - c, d + c, y + x
    return (e * f % p, g * h % p, f * g % p, e * h % p)


def _ed_mul(s, point):
    result = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            result = _ed_add(result, point)
        point = _ed_add(point, point)
        s >>= 1
    return result


def _ed_point(data):
    """The curve point stored in 32 bytes, or None if they are not one."""
    if len(data) != 32:
        return None
    y = int.from_bytes(data, "little")
    sign, y = y >> 255, y & ((1 << 255) - 1)
    if y >= ED_P:
        return None
    x2 = (y * y - 1) * pow(ED_D * y * y + 1, ED_P - 2, ED_P) % ED_P
    if x2 == 0:
        if sign:
            return None
        x = 0
    else:
        x = pow(x2, (ED_P + 3) // 8, ED_P)
        if (x * x - x2) % ED_P:
            x = x * ED_SQRT_M1 % ED_P
        if (x * x - x2) % ED_P:
            return None
        if (x & 1) != sign:
            x = ED_P - x
    return (x, y, 1, x * y % ED_P)


_ED_BASE = _ed_point(int.to_bytes(4 * pow(5, ED_P - 2, ED_P) % ED_P, 32, "little"))


def ed25519_verify(public, message, signature):
    if len(signature) != 64:
        return False
    a, r = _ed_point(public), _ed_point(signature[:32])
    s = int.from_bytes(signature[32:], "little")
    if not a or not r or s >= ED_Q:
        return False
    h = int.from_bytes(hashlib.sha512(signature[:32] + public + message).digest(), "little") % ED_Q
    left, right = _ed_mul(s, _ED_BASE), _ed_add(r, _ed_mul(h, a))
    return (left[0] * right[2] - right[0] * left[2]) % ED_P == 0 and (left[1] * right[2] - right[1] * left[2]) % ED_P == 0


def version_key(text):
    return tuple(int(part) for part in str(text).split("."))


def signed_update(manifest_b64, signature_b64):
    """A version's description, if it is properly signed and well formed: (text, signature, manifest)."""
    try:
        text = base64.b64decode(manifest_b64, validate=True)
        signature = base64.b64decode(signature_b64, validate=True)
    except (TypeError, ValueError):
        return None
    if len(text) > 16384 or not ed25519_verify(UPDATE_KEY, text, signature):
        return None
    try:
        manifest = json.loads(text)
        packages = manifest["packages"]
        ok = (manifest.get("product") == "umbryx-desktop" and UPDATE_VERSION.match(str(manifest.get("version")))
              and isinstance(packages, dict) and packages and all(
                  isinstance(p, dict) and UPDATE_FILE.match(str(p.get("file"))) and p["file"] != "latest.json"
                  and isinstance(p.get("size"), int) and 0 < p["size"] <= MAX_UPDATE_BYTES
                  and re.fullmatch(r"[0-9a-f]{64}", str(p.get("sha256"))) for p in packages.values()))
    except (ValueError, KeyError, TypeError, AttributeError):
        return None
    return (text, signature, manifest) if ok else None


def published_update():
    """The manifest of the version on offer now, or None."""
    with contextlib.suppress(OSError, ValueError, KeyError, TypeError):
        saved = json.loads((UPDATES / "latest.json").read_text("utf-8"))
        return json.loads(saved["manifest"])
    return None


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def page_build():
    """A short fingerprint of the interface's files. It changes whenever any of them does, so an open page can
    tell that the server now has a newer interface than the one it loaded."""
    digest = hashlib.sha1()
    for path in sorted(PUBLIC.rglob("*")):
        if path.is_file():
            st = path.stat()
            digest.update(("%s:%d:%d;" % (path.relative_to(PUBLIC).as_posix(), st.st_size, st.st_mtime_ns)).encode())
    return digest.hexdigest()[:12]


def hash_password(password, salt_hex):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), PBKDF2_ROUNDS).hex()


def token_hash(token):
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


def load_config():
    cfg = dict(DEFAULTS)
    if CONFIG_FILE.exists():
        try:
            cfg.update(json.loads(CONFIG_FILE.read_text("utf-8")))
        except (OSError, ValueError) as err:
            print("  ! config.json could not be read (%s). Using the defaults." % err)
    else:
        save_config(cfg)
    return cfg


def save_config(cfg):
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2) + "\n", "utf-8")


def is_local(req, writer):
    """True only for a browser on this computer talking to the server directly.

    The automatic sign-in depends on this, so it is strict: the connection must come from the
    loopback address, be addressed to localhost, and carry no sign of a tunnel or proxy in front.
    """
    peer = (writer.get_extra_info("peername") or ("",))[0]
    host = req.headers.get("host", "").lower()
    name = host[:host.find("]") + 1] if host.startswith("[") else host.rsplit(":", 1)[0]
    return peer in LOOPBACK and name in LOCAL_HOSTS and not any(h in req.headers for h in PROXY_HEADERS)


def lan_addresses():
    found = []
    with contextlib.suppress(OSError):
        # Connecting a UDP socket sends nothing; it only reveals the outbound interface.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.0.2.1", 9))
            found.append(probe.getsockname()[0])
    with contextlib.suppress(OSError):
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.append(info[4][0])
    seen = []
    for ip in found:
        if ip not in seen and not ip.startswith("127.") and ip != "0.0.0.0":
            seen.append(ip)
    return seen


def public_hosts(cfg):
    """Addresses people use to reach this server, from config.json ("hosts") and UMBRYX_HOSTS.

    Inside a container the server cannot see the machine's real address, so it has to be told.
    """
    listed = list(cfg.get("hosts") or []) + os.environ.get("UMBRYX_HOSTS", "").split(",")
    seen = []
    for item in listed:
        name = str(item).strip().lower()
        if name and name not in seen:
            seen.append(name)
    return seen


def is_ip(text):
    try:
        ipaddress.ip_address(text)
        return True
    except ValueError:
        return False


_cert_seen = {}


def cert_fingerprint():
    """The SHA-256 of this server's own certificate (as DER): what a desktop app that trusted it remembers it by.
    Not secret: anyone connecting to the secure port is shown the certificate."""
    try:
        stamp = (DATA / "cert.pem").stat().st_mtime
        if _cert_seen.get("stamp") != stamp:
            der = ssl.PEM_cert_to_DER_cert((DATA / "cert.pem").read_text("ascii"))
            _cert_seen.update(stamp=stamp, value=hashlib.sha256(der).hexdigest())
        return _cert_seen["value"]
    except (OSError, ValueError):
        return ""


def bare_host(value):
    """A Host header's name, without its port: "umbryx.vlcno.xyz:443" -> "umbryx.vlcno.xyz", "[::1]:3000" -> "::1"."""
    value = (value or "").strip().lower()
    if value.startswith("["):
        return value[1:value.find("]")] if "]" in value else ""
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


def app_address(cfg):
    """config.json's "appAddress", if it is a secure address ("https://..."), else ""."""
    value = str(cfg.get("appAddress") or "").strip()
    return value if re.match(r"^https://[A-Za-z0-9.-]+(:\d+)?/?$", value) else ""


def tls_context(addresses, extra=()):
    """Load the server certificate, creating one on first run or when the server's addresses change."""
    cert, key, meta = DATA / "cert.pem", DATA / "key.pem", DATA / "cert.json"
    host = socket.gethostname()
    dns_names = sorted({"localhost", host, *(name for name in extra if not is_ip(name))})
    ips = sorted({"127.0.0.1", "::1", *addresses, *(name for name in extra if is_ip(name))})
    wanted = set(dns_names) | set(ips)
    fresh = False
    with contextlib.suppress(OSError, ValueError, KeyError, TypeError):
        info = json.loads(meta.read_text("utf-8"))
        fresh = cert.exists() and key.exists() and wanted <= set(info["names"]) and info["expires"] - time.time() > 14 * 86400
    try:
        if not fresh:
            print("  Creating a security certificate for this computer (one time, a few seconds)...")
            cert_pem, key_pem, expires = certgen.generate("Umbryx on " + host, dns_names, ips)
            cert.write_text(cert_pem, "ascii")
            key.write_text(key_pem, "ascii")
            meta.write_text(json.dumps({"names": sorted(wanted), "expires": expires}), "utf-8")
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(str(cert), str(key))
        return ctx
    except Exception as err:  # HTTPS is optional: the host can still use http://localhost
        print("  ! HTTPS could not be set up (%s). Only this computer will be able to use voice." % err)
        return None


# --- WebSocket framing ---------------------------------------------------

def ws_frame(opcode, payload=b""):
    n = len(payload)
    if n < 126:
        head = bytes([0x80 | opcode, n])
    elif n < 65536:
        head = bytes([0x80 | opcode, 126]) + struct.pack(">H", n)
    else:
        head = bytes([0x80 | opcode, 127]) + struct.pack(">Q", n)
    return head + payload


def ws_unmask(data, mask):
    n = len(data)
    if not n:
        return b""
    pad = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, "big") ^ int.from_bytes(pad, "big")).to_bytes(n, "big")


async def ws_read(reader, client):
    """Return the next text message, or None when the peer closes."""
    message = bytearray()
    while True:
        b1, b2 = await reader.readexactly(2)
        opcode, length = b1 & 0x0F, b2 & 0x7F
        if length == 126:
            length = struct.unpack(">H", await reader.readexactly(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", await reader.readexactly(8))[0]
        if not b2 & 0x80 or length + len(message) > MAX_WS_MESSAGE:
            return None
        mask = await reader.readexactly(4)
        payload = ws_unmask(await reader.readexactly(length), mask)
        client.last_seen = time.monotonic()
        if opcode == 0x8:
            return None
        if opcode == 0x9:
            client.send_raw(ws_frame(0xA, payload))
            continue
        if opcode == 0xA:
            continue
        if opcode in (0x1, 0x2):
            message = bytearray(payload)
        elif opcode == 0x0:
            message += payload
        else:
            return None
        if b1 & 0x80:
            return message.decode("utf-8", "replace")


# --- accounts, chat and voice state --------------------------------------

class Client:
    """One open connection (a browser tab, the desktop app or the phone app). `user` is the signed-in
    account record. One account can have several at once; voice is per connection, and at most one of an
    account's connections is in voice at a time."""

    def __init__(self, writer):
        self.writer = writer
        self.ip = (writer.get_extra_info("peername") or ("?",))[0]
        self.token = secrets.token_urlsafe(24)   # authorises uploads for this connection
        self.local = False                       # set when the browser is on the server computer itself
        self.user = None
        self.voice = None
        self.muted = False
        self.deafened = False
        self.sharing = False
        self.camera = False
        self.idle = False                        # this device has been left alone for a while
        self.away = False                        # nobody has used it for a few minutes (on_away): pushes reach the phone
        self.device = "web"                      # "desktop", "web" or "mobile" (see device_of and on_auth)
        self.host = ""                           # the address it came to (for passkeys, see Hub.passkey_domain)
        self.background = False                  # the phone app is in the background (app-state): push to it
        self.session_key = ""                    # token_hash of the sign-in session it uses (push tokens belong to it)
        self.passkey_create = None               # its last "add a passkey" challenge (a new one replaces it)
        self.activities = []                     # what its person is playing, heard by this device (on_activity)
        self.activities_at = 0.0
        self.since = self.last_seen = time.monotonic()
        self.recent = deque(maxlen=8)
        self.embed_asks = deque()                # when this connection last asked for link previews
        self.invite_asks = deque(maxlen=30)      # when it last asked about invite links (on_invite_info)

    @property
    def id(self):
        return self.user["id"] if self.user else None

    @property
    def name(self):
        return self.user["name"] if self.user else ""

    def send(self, obj):
        self.send_raw(ws_frame(0x1, dumps(obj).encode("utf-8")))

    def send_raw(self, frame):
        writer = self.writer
        if writer.is_closing():
            return
        if writer.transport.get_write_buffer_size() > MAX_WS_BACKLOG:
            writer.transport.abort()
            return
        writer.write(frame)

    def voice_state(self):
        return {"voice": self.voice, "muted": self.muted, "deafened": self.deafened, "sharing": self.sharing,
                "camera": self.camera}


class Hub:
    def __init__(self, cfg):
        self.cfg = cfg
        self.https_port = None
        self.sockets = set()   # every open WebSocket, signed in or not
        self.online = {}       # user id -> [Client, ...]: every open connection of each signed-in account
        self.tokens = {}       # upload token -> Client
        self.calls = {}        # call id -> one-on-one call (ringing or active)
        self.voice_started = {}   # voice channel or call room -> when its first person arrived (time.monotonic)
        self.emojis = []       # custom emoji: {"name", "url", "by"}
        with contextlib.suppress(OSError, ValueError):
            saved = json.loads((DATA / "emojis.json").read_text("utf-8"))
            self.emojis = [e for e in saved if isinstance(e, dict) and e.get("name") and e.get("url")]
        self.auth_fails = {}   # ip -> recent failed sign-ins
        self.invites = []      # invite codes: {"code", "by", "created", "expires", "max", "uses", "joined"}
        with contextlib.suppress(OSError, ValueError):
            saved = json.loads((DATA / "invites.json").read_text("utf-8"))
            self.invites = [x for x in saved if isinstance(x, dict) and x.get("code")]
        self.reports = []      # reports to the admins (see on_report); closed ones are kept a while (REPORT_KEEP_DAYS)
        with contextlib.suppress(OSError, ValueError):
            saved = json.loads((DATA / "reports.json").read_text("utf-8"))
            self.reports = [x for x in saved if isinstance(x, dict) and x.get("id")]
        self.report_times = {}   # account id -> when it sent its reports this past hour
        self.embed_cache = {}  # (kind, id) -> (until, preview or None): link previews looked up lately
        self.embed_lookups = {}   # (kind, id) -> the lookup under way, shared by everyone asking meanwhile
        self.passkey_asks = {}    # challenge -> {"exp", "rp", "kind", "uid"}: passkey requests waiting for an answer
        self.passkey_ips = {}     # ip -> when it last asked for a passkey sign-in challenge
        self.passkey_links = {}   # token -> {"uid", "exp"}: one-time links to add a passkey in a web browser
        self.push_auth = None     # (Apple provider token, made at, (team, key id)) for push notifications
        self.push_warned = False
        self._load_users()
        self.channels = self._load_channels()
        self.messages = {c["id"]: self._load_lines(MESSAGES / (c["id"] + ".jsonl")) for c in self.channels if c["type"] == "text"}
        self.dms = {path.stem: self._load_lines(path) for path in DMS.glob("*.jsonl")}
        everything = list(self.messages.values()) + list(self.dms.values())
        self.seq = max((m["id"] for msgs in everything for m in msgs), default=0)
        # Once, when config.json asks ("removeGuests", set by setup/remove_guests_setup.py): the "Skip for now" guest
        # accounts left over (no password; nobody can make one any more) are deleted like any account.
        if self.cfg.get("removeGuests"):
            gone = [r for r in list(self.users.values()) if r.get("guest") and not r.get("hash") and not r.get("deleted")]
            for rec in gone:
                self._delete_account(rec, rec)
            self.cfg["removeGuests"] = False
            save_config(self.cfg)
            log("removed %d Skip for now guest account%s" % (len(gone), "" if len(gone) == 1 else "s"))
        self.handlers = {
            "auth": self.on_auth, "logout": self.on_logout, "profile": self.on_profile,
            "status": self.on_status, "note": self.on_note, "dm-ping": self.on_dm_ping, "echo": self.on_echo,
            "theme": self.on_theme, "idle": self.on_idle, "search": self.on_search, "server-update": self.on_server_update,
            "activity": self.on_activity, "embed": self.on_embed,
            "message-delete": self.on_message_delete, "message-pin": self.on_message_pin, "pins": self.on_pins,
            "emoji-add": self.on_emoji_add, "emoji-remove": self.on_emoji_remove, "favorite": self.on_favorite,
            "chat": self.on_chat, "history": self.on_history, "typing": self.on_typing,
            "message-edit": self.on_message_edit,
            "dm-send": self.on_dm_send, "dm-history": self.on_dm_history, "dm-read": self.on_dm_read, "dm-close": self.on_dm_close,
            "server-mute": self.on_server_mute, "server-deafen": self.on_server_deafen,
            "ban": self.on_ban, "unban": self.on_unban, "bans": self.on_bans, "invite-info": self.on_invite_info,
            "passkey-begin": self.on_passkey_begin, "passkey-finish": self.on_passkey_finish,
            "passkey-remove": self.on_passkey_remove, "passkey-link": self.on_passkey_link, "channel-notify": self.on_channel_notify, "push-token": self.on_push_token, "app-state": self.on_app_state,
            "friend-add": self.on_friend_add, "friend-accept": self.on_friend_accept,
            "friend-remove": self.on_friend_remove,
            "voice-join": self.on_voice_join, "voice-leave": self.on_voice_leave, "voice-flags": self.on_voice_flags,
            "signal": self.on_signal,
            "call-invite": self.on_call_invite, "call-answer": self.on_call_answer, "call-end": self.on_call_end,
            "channel-create": self.on_channel_create, "channel-delete": self.on_channel_delete,
            "channel-rename": self.on_channel_rename, "claim": self.on_claim, "admit": self.on_admit,
            "redeem": self.on_redeem, "invites": self.on_invites, "invite-create": self.on_invite_create,
            "invite-delete": self.on_invite_delete, "account-delete": self.on_account_delete, "kick": self.on_kick,
            "nickname": self.on_nickname,
            "block": self.on_block, "unblock": self.on_unblock, "report": self.on_report, "reports": self.on_reports,
            "report-close": self.on_report_close, "report-done": self.on_report_close, "away": self.on_away,
        }

    # storage

    def _load_users(self):
        self.users, self.sessions = {}, {}
        with contextlib.suppress(OSError, ValueError, AttributeError):
            saved = json.loads((DATA / "users.json").read_text("utf-8"))
            self.users, self.sessions = saved.get("users", {}), saved.get("sessions", {})
        self.names = {rec["name"].casefold(): rec for rec in self.users.values() if not rec.get("deleted")}
        # Accounts made before Early Supporter came with an account were all made in the early days.
        for rec in self.users.values():
            rec.setdefault("early", True)

    def _save_users(self):
        write_json(DATA / "users.json", {"users": self.users, "sessions": self.sessions})

    def _load_channels(self):
        path = DATA / "channels.json"
        with contextlib.suppress(OSError, ValueError, AttributeError):
            channels = json.loads(path.read_text("utf-8"))
            if isinstance(channels, list) and any(c.get("type") == "text" for c in channels):
                return channels
        write_json(path, DEFAULT_CHANNELS)
        return [dict(c) for c in DEFAULT_CHANNELS]

    @staticmethod
    def _load_lines(path):
        out = []
        with contextlib.suppress(OSError):
            with open(path, encoding="utf-8") as f:
                for line in f:
                    with contextlib.suppress(ValueError):
                        out.append(json.loads(line))
        return out

    @staticmethod
    def _append_line(path, msg):
        with open(path, "a", encoding="utf-8") as f:
            f.write(dumps(msg) + "\n")

    # helpers

    def channel(self, channel_id, kind):
        for c in self.channels:
            if c["id"] == channel_id and c["type"] == kind:
                return c
        return None

    def conns(self, user_id):
        """Every open connection of an account: its browser tabs, desktop app and phone."""
        return self.online.get(user_id, [])

    def devices_of(self, user_id):
        """What an account is signed in on now, the desktop app first (see DEVICES)."""
        on = {x.device for x in self.conns(user_id)}
        return [d for d in DEVICES if d in on]

    def voice_conn(self, user_id):
        """The one connection through which an account is in voice, if it is."""
        return next((x for x in self.conns(user_id) if x.voice), None)

    def everyone(self):
        return [x for conns in list(self.online.values()) for x in conns]

    def public(self, rec):
        online = bool(self.conns(rec["id"]))
        talker = self.voice_conn(rec["id"])
        note = self.note_of(rec)
        return {"id": rec["id"], "name": rec["name"], "display": rec.get("display", ""), "plate": rec.get("plate", ""), "plateFit": rec.get("plateFit"),
                "avatar": rec["avatar"], "banner": rec["banner"],
                "about": rec["about"], "status": rec.get("status", "online"), "color": rec.get("color", ""),
                "fit": rec.get("avatarFit"), "bannerFit": rec.get("bannerFit"), "badges": self.badges_of(rec),
                "guest": bool(rec.get("guest")), "deleted": bool(rec.get("deleted")),
                "note": note, "noteUntil": rec.get("noteUntil", 0) if note else 0,
                # Idle once every device it is signed in on has been left alone (see on_idle).
                "idle": online and all(x.idle for x in self.conns(rec["id"])),
                "activities": self.shown_activities(rec["id"]),
                # Muted or deafened by an admin (see on_server_mute): kept until an admin takes it off.
                "serverMuted": bool(rec.get("serverMuted")), "serverDeafened": bool(rec.get("serverDeafened")),
                "devices": self.devices_of(rec["id"]),   # what they are on: "desktop", "web", "mobile"
                "online": online, **(talker.voice_state() if talker else NO_VOICE)}

    def seen_by(self, viewer, rec):
        """How much viewer may know of rec: "all", "name" or nothing (None). Between members, everything. A guest is out
        of everyone's sight, and everyone out of a guest's, except friends and someone asking to be your friend;
        someone you have asked shows only their name until they say yes."""
        if viewer is rec or not (viewer.get("guest") or rec.get("guest")):
            return "all"
        if rec["id"] in viewer["friends"] or rec["id"] in viewer["incoming"]:
            return "all"
        # Someone you asked shows only their name until they say yes; so does someone you blocked (to unblock them).
        return "name" if rec["id"] in viewer["outgoing"] or rec["id"] in (viewer.get("blocked") or ()) else None

    def public_for(self, viewer, rec):
        """public(rec) as viewer may see it (see seen_by), or None."""
        seen = self.seen_by(viewer, rec)
        if seen is None:
            return None
        shown = self.public(rec)
        if seen == "name":
            shown.update(about="", note="", noteUntil=0, idle=False, activities=[], devices=[], online=False,
                         serverMuted=False, serverDeafened=False, **NO_VOICE)
        elif viewer.get("guest") and self.channel(shown["voice"], "voice"):
            shown.update(NO_VOICE)   # guests do not see the server's voice channels, nor who is in them
        return shown

    @staticmethod
    def blocks(rec, other):
        """Whether either of the two has blocked the other (see on_block)."""
        return other["id"] in (rec.get("blocked") or ()) or rec["id"] in (other.get("blocked") or ())

    @staticmethod
    def may_reach(rec, other):
        """Whether rec may message or call other: anyone, between members; with a guest, only friends. Never when
        either has blocked the other."""
        if rec.get("deleted") or other.get("deleted") or Hub.blocks(rec, other):
            return False
        return not (rec.get("guest") or other.get("guest")) or other["id"] in rec["friends"]

    def activities_of(self, user_id):
        """What an account is doing, as the device that last said so heard it."""
        told = [x for x in self.conns(user_id) if x.activities]
        return max(told, key=lambda x: x.activities_at).activities if told else []

    def shown_activities(self, user_id):
        now = time.monotonic()
        shown = []
        for act in self.activities_of(user_id):
            item = {k: v for k, v in act.items() if k not in ("since", "until")}
            item["ago"] = int((now - act["since"]) * 1000) if act["since"] is not None else None
            item["left"] = max(0, int((act["until"] - now) * 1000)) if act["until"] is not None else None
            shown.append(item)
        return shown

    def can_manage(self, rec):
        """Who may change the server's name, picture and banner: those listed in config.json's "admins" (by name, any
        capitals, or id). Without that list, those with the Server Owner badge, as before. Never a guest."""
        if rec.get("guest"):
            return False
        admins = self.cfg.get("admins")
        if isinstance(admins, list):
            return any(str(a) == rec["id"] or str(a).casefold() == rec["name"].casefold() for a in admins)
        return "owner" in self.badges_of(rec)

    def can_moderate(self, rec):
        """Who sees and handles reports, and may delete anyone's message in a channel: the server's admins, and
        Umbryx Staff."""
        if rec.get("guest") or rec.get("deleted"):
            return False
        return self.can_manage(rec) or "staff" in self.badges_of(rec)

    def badges_of(self, rec):
        """The badges config.json gives this account, by its id or (in any case) its name."""
        table = self.cfg.get("badges") if isinstance(self.cfg.get("badges"), dict) else {}
        given = table.get(rec["id"])
        if given is None:
            given = next((v for k, v in table.items() if str(k).casefold() == rec["name"].casefold()), [])
        given = given if isinstance(given, list) else []
        # Early Supporter comes with an account made while config.json's "earlySupporters" was on (see _load_users).
        return [b for b in BADGES if b in given or (b == "early" and rec.get("early"))]

    @staticmethod
    def note_of(rec):
        """Someone's custom status text, or nothing once its time is up."""
        until = rec.get("noteUntil", 0)
        return "" if until and until <= time.time() * 1000 else rec.get("note", "")

    def auto_account(self):
        """The account that signs in without a password on the server computer, if one is configured."""
        return self.names.get(str(self.cfg.get("autoLogin") or "").casefold())

    def broadcast(self, obj, skip=None, skip_user=None):
        """To everyone signed in, except one connection (skip) or every device of one account (skip_user). Guests hear
        only of the people they know (see seen_by) and of their own calls, never of the server's channels."""
        hears, for_guests = self._audience(obj)
        frame = ws_frame(0x1, dumps(obj).encode("utf-8"))
        guest_frame = ws_frame(0x1, dumps(for_guests).encode("utf-8")) if for_guests is not None else None
        for client in self.everyone():
            if client is skip or client.id == skip_user or not hears(client.user):
                continue
            if not client.user.get("guest"):
                client.send_raw(frame)
            elif guest_frame is not None:
                client.send_raw(guest_frame)

    def _audience(self, obj):
        """For broadcast: who may hear obj, and what the guests among them hear (None: nothing)."""
        kind = obj.get("type")
        if kind in ("user-join", "user-update", "user-leave", "voice-update"):
            rec = self.users.get(obj["user"]["id"] if "user" in obj else obj.get("id"))
            guests = obj
            if self.channel(obj.get("user", obj).get("voice"), "voice"):   # in one of the server's voice channels
                guests = None if kind == "voice-update" else {**obj, "user": {**obj["user"], **NO_VOICE}}
            return (lambda viewer: rec is not None and self.seen_by(viewer, rec) == "all"), guests
        if kind == "voice-started" and not self.channel(obj.get("room"), "voice"):
            call = self._call_room(obj.get("room"))   # a call: the two people in it hear about it, guests or not
            return (lambda viewer: not viewer.get("guest") or bool(call) and viewer["id"] in (call["from"], call["to"])), obj
        return (lambda viewer: True), None

    def send_to(self, user_id, obj):
        """To every device the account is signed in on."""
        frame = ws_frame(0x1, dumps(obj).encode("utf-8"))
        for client in list(self.conns(user_id)):
            client.send_raw(frame)

    def dispatch(self, client, msg):
        kind = msg.get("type")
        handler = self.handlers.get(kind)
        if not handler or (client.user is None and kind != "auth"):
            return
        if client.user is not None and client.user.get("guest") and kind in GUEST_BARRED:
            if kind in GUEST_BARRED_WHY:
                client.send({"type": "error", "code": "guest", "message": GUEST_BARRED_WHY[kind]})
            return
        try:
            handler(client, msg)
        except Kick:
            raise
        except Exception:
            traceback.print_exc()

    def drop(self, client):
        self.sockets.discard(client)
        self.tokens.pop(client.token, None)
        conns = self.online.get(client.id) if client.user is not None else None
        if not conns or client not in conns:
            return
        if client.voice:
            self.on_voice_leave(client)   # the device that was in voice went away (a call it was in ends)
        was = (all(x.idle for x in conns), self.activities_of(client.id), self.devices_of(client.id))
        conns.remove(client)
        if conns:
            # Still signed in on another device; what this one was playing goes with it, and maybe its kind.
            if (all(x.idle for x in conns), self.activities_of(client.id), self.devices_of(client.id)) != was:
                self.broadcast({"type": "user-update", "user": self.public(client.user)})
            return
        # Their calls end, except one still ringing for them: it rings on (their phone, through its push) until it's
        # answered or goes unanswered, as when a phone puts the app in the background.
        for call in [x for x in self.calls.values() if client.id == x["from"] or (client.id == x["to"] and x["active"])]:
            self._end_call(call, "left", by=client)
        del self.online[client.id]
        self.broadcast({"type": "user-leave", "id": client.id})
        log("%s went offline" % client.name)

    async def heartbeat(self):
        ping = ws_frame(0x9)
        while True:
            await asyncio.sleep(25)
            now = time.monotonic()
            for client in list(self.sockets):
                stale = now - client.last_seen > 75
                idle_guest = client.user is None and now - client.since > 30
                if stale or idle_guest:
                    client.writer.transport.abort()
                else:
                    client.send_raw(ping)
            self.expire_notes()

    def expire_notes(self):
        """Clear custom statuses whose time is up, and tell everyone."""
        changed = [rec for rec in self.users.values() if rec.get("note") and not self.note_of(rec)]
        for rec in changed:
            rec["note"], rec["noteUntil"] = "", 0
            self.broadcast({"type": "user-update", "user": self.public(rec)})
        if changed:
            self._save_users()

    def too_fast(self, c):
        now = time.time()
        if len(c.recent) == c.recent.maxlen and now - c.recent[0] < 5:
            c.send({"type": "error", "code": "slow-down", "message": "You are sending messages too quickly."})
            return True
        c.recent.append(now)
        return False

    def _attachments(self, raw):
        out = []
        if not isinstance(raw, list):
            return out
        for item in raw[:8]:
            hit = UPLOAD_URL.match(str(item.get("url") or "")) if isinstance(item, dict) else None
            if not hit:
                continue
            path = UPLOADS / hit.group(1)
            if not path.is_file():
                continue
            entry = {
                "url": "/uploads/" + hit.group(1),
                "name": clean_text(item.get("name"), 120) or "file",
                "size": path.stat().st_size,
                "kind": INLINE_TYPES.get(path.suffix, "file/").split("/")[0],
            }
            if item.get("spoiler") and entry["kind"] in ("image", "video"):
                entry["spoiler"] = True   # shown blurred until the reader clicks it
            out.append(entry)
        return out

    @staticmethod
    def _reply_to(msgs, reply_id):
        """A small copy of the message being replied to, kept with the reply so it still reads after deletion."""
        original = next((x for x in msgs if x["id"] == reply_id), None) if isinstance(reply_id, int) else None
        if not original:
            return None
        text = original.get("text") or ""
        if not text and original.get("attachments"):
            text = "Attachment"
        return {"id": original["id"], "uid": original.get("uid"), "name": original.get("name", ""), "text": text[:140]}

    @staticmethod
    def _page(msgs, before):
        end = len(msgs)
        if isinstance(before, int):
            lo, hi = 0, len(msgs)
            while lo < hi:
                mid = (lo + hi) // 2
                if msgs[mid]["id"] < before:
                    lo = mid + 1
                else:
                    hi = mid
            end = lo
        start = max(0, end - HISTORY_PAGE)
        return {"messages": msgs[start:end], "more": start > 0, "older": isinstance(before, int)}

    # accounts

    def _auth_error(self, c, code, message, count=False):
        if count:
            self.auth_fails.setdefault(c.ip, deque(maxlen=10)).append(time.time())
        c.send({"type": "error", "code": code, "message": message})
        raise Kick()

    def on_auth(self, c, m):
        if c.user is not None:
            return
        fails = self.auth_fails.get(c.ip)
        if fails and len(fails) == fails.maxlen and time.time() - fails[0] < 300:
            self._auth_error(c, "auth-wait", "Too many failed attempts. Wait a few minutes and try again.")
        mode, session = m.get("mode"), None
        if mode == "resume":
            rec = self.users.get(self.sessions.get(token_hash(m.get("session"))))
            if not rec:
                self._auth_error(c, "bad-session", "Please sign in again.")
            c.session_key = token_hash(m.get("session"))
        elif mode == "auto":
            rec = self.auto_account() if c.local else None
            if not rec:
                self._auth_error(c, "no-auto", "")
        elif mode == "login":
            rec = self.names.get(clean_text(m.get("name"), 32).casefold())
            password = str(m.get("password") or "")
            if not rec or not rec.get("hash") or not hmac.compare_digest(hash_password(password, rec["salt"]), rec["hash"]):
                self._auth_error(c, "bad-login", "That username or password is not right.", count=True)
        elif mode == "register":
            name = clean_text(m.get("name"), 32)
            password = str(m.get("password") or "")
            gate = str(self.cfg.get("password") or "")
            if gate and not hmac.compare_digest(str(m.get("serverPassword") or "").encode("utf-8"), gate.encode("utf-8")):
                self._auth_error(c, "bad-server-password", "That server password is not right.", count=True)
            invite = None
            if str(m.get("invite") or "").strip():
                invite = self._invite(m.get("invite"))
                if not invite:
                    self._auth_error(c, "bad-invite", "That invite code is not valid, or has run out.", count=True)
            if not USERNAME.match(name):
                self._auth_error(c, "bad-name", "Usernames are 2 to 24 letters, numbers, spaces, dots, dashes or underscores.")
            if name.casefold() in self.names or name.casefold() == DELETED_NAME.casefold():
                self._auth_error(c, "name-taken", "That username is taken. Try another one.")
            if len(password) < 6:
                self._auth_error(c, "weak-password", "Use a password with at least 6 characters.")
            salt = secrets.token_hex(16)
            rec = {"id": secrets.token_hex(6), "name": name, "salt": salt, "hash": hash_password(password, salt),
                   "avatar": "", "banner": "", "about": "", "friends": [], "incoming": [], "outgoing": [],
                   "read": {}, "created": int(time.time()), "early": bool(self.cfg.get("earlySupporters", True))}
            if invite:
                self._use_invite(invite, rec)
            elif self.cfg.get("inviteOnly", True):
                rec["guest"] = True   # in direct messages with friends until they have an invite code
            self.users[rec["id"]] = rec
            self.names[name.casefold()] = rec
            log("%s created an account%s" % (name, " with an invite" if invite else " (in direct messages until invited)" if rec.get("guest") else ""))
            if invite:
                self._announce_join(rec)
        elif mode == "passkey":
            rec = self._passkey_sign_in(c, m)
        elif mode == "guest":
            # "Skip for now" (an account without a password) is gone: older apps that still offer it are told so.
            self._auth_error(c, "no-guests", "Skip for now is gone: make an account. An invite code is optional.")
        else:
            return
        if mode != "resume":
            session = secrets.token_urlsafe(32)
            c.session_key = token_hash(session)
            self.sessions[c.session_key] = rec["id"]
            # Browsers that were closed without signing out leave tokens behind: keep the newest ten per account.
            mine = [key for key, uid in self.sessions.items() if uid == rec["id"]]
            for key in mine[:-10]:
                self.forget_session(key)
            self._save_users()
        if m.get("client") in DEVICES:   # what it is, said by itself (newer pages and phone apps)
            c.device = m["client"]
        self._sign_in(c, rec, session)

    def on_claim(self, c, m):
        """A guest makes theirs an account: a username and password, so they can sign in on any device. They stay a
        guest (in direct messages only, see seen_by) until an admin lets them into the server (on_admit)."""
        rec = c.user
        if not rec.get("guest") or rec.get("hash"):
            return
        name, password = clean_text(m.get("name"), 32), str(m.get("password") or "")
        taken = self.names.get(name.casefold())
        invite = self._invite(m.get("invite")) if str(m.get("invite") or "").strip() else None
        problem = ("Usernames are 2 to 24 letters, numbers, spaces, dots, dashes or underscores." if not USERNAME.match(name)
                   else "That username is taken. Try another one." if (taken and taken is not rec) or name.casefold() == DELETED_NAME.casefold()
                   else "Use a password with at least 6 characters." if len(password) < 6
                   else "That invite code is not valid, or has run out." if str(m.get("invite") or "").strip() and not invite else "")
        if problem:
            c.send({"type": "error", "code": "claim", "message": problem})
            return
        if name != rec["name"]:
            del self.names[rec["name"].casefold()]
            rec["name"] = name
            self.names[name.casefold()] = rec
        rec["salt"] = secrets.token_hex(16)
        rec["hash"] = hash_password(password, rec["salt"])
        rec["early"] = bool(self.cfg.get("earlySupporters", True))
        self._save_users()
        log("guest %s made an account" % name)
        self.send_to(rec["id"], {"type": "account-made", "name": name})
        self.broadcast({"type": "user-update", "user": self.public(rec)})   # a new name, and the Early Supporter badge
        if invite and not rec.get("banned"):
            self._use_invite(invite, rec)
            self._let_in(rec, "with an invite code")

    def on_admit(self, c, m):
        """An admin lets a guest into the server: a member from then on, keeping their friends, messages and profile.
        Only a guest who has made an account (with a password) can be let in. Their devices are told and
        disconnected, and come straight back with the whole server."""
        if not self.can_manage(c.user):
            c.send({"type": "error", "code": "not-owner", "message": "Only the server's admins can let guests in."})
            return
        rec = self.users.get(m.get("id"))
        if not rec or not rec.get("guest"):
            return
        if not rec.get("hash"):
            c.send({"type": "error", "code": "admit",
                    "message": "%s needs to make an account first (Make an account, at the top of their sidebar)." % rec["name"]})
            return
        if rec.pop("banned", None):   # letting a banned person in is unbanning them
            self._send_bans()
        self._let_in(rec, "let in by %s" % c.name)

    def _announce_join(self, rec):
        """Someone joined the server: a line in the first text channel, as in Discord ("X joined the party."). The
        server picks which of the apps' greetings (join: 0 to JOIN_KINDS - 1); they write it with the person's name."""
        channel = next((x for x in self.channels if x["type"] == "text"), None)
        if not channel or not self.cfg.get("joinMessages", True):
            return
        self.seq += 1
        msg = {"id": self.seq, "channel": channel["id"], "uid": rec["id"], "name": rec["name"], "ts": int(time.time() * 1000),
               "text": "", "join": secrets.randbelow(JOIN_KINDS)}
        self.messages[channel["id"]].append(msg)
        self._append_line(MESSAGES / (channel["id"] + ".jsonl"), msg)
        self.broadcast({"type": "chat", "message": msg})

    def _let_in(self, rec, how):
        """A guest becomes a member (see on_admit): everyone sees them, and their devices come back with the server."""
        rec.pop("guest", None)
        self._save_users()
        log("%s joined the server, %s" % (rec["name"], how))
        self.broadcast({"type": "user-update", "user": self.public(rec)})   # now every member sees them
        self._announce_join(rec)
        for x in list(self.conns(rec["id"])):
            x.send({"type": "admitted"})
            x.writer.close()

    def on_kick(self, c, m):
        """An admin removes someone from the server: they keep their account, friends and direct messages with friends,
        but are outside it again, like an account without an invite code, until someone gives them a new code. Not
        an admin, not a canDeleteStaff account, not yourself. Their devices are told and disconnected, and come
        straight back outside the server; everyone else now sees them as a guest does (see seen_by)."""
        if not self.can_manage(c.user):
            c.send({"type": "error", "code": "not-owner", "message": "Only the server's admins can remove people from it."})
            return
        rec = self.users.get(m.get("id"))
        if not rec or rec is c.user or rec.get("guest") or rec.get("deleted"):
            return
        if self.can_manage(rec) or self._listed(rec, "canDeleteStaff"):
            c.send({"type": "error", "code": "kick", "message": "%s can't be removed from the server." % rec["name"]})
            return
        rec["guest"] = True
        self._save_users()
        log("%s removed %s from the server" % (c.name, rec["name"]))
        for client in self.everyone():
            if client.id != rec["id"]:
                shown = self.public_for(client.user, rec)
                client.send({"type": "user-update", "user": shown} if shown else {"type": "user-hidden", "id": rec["id"]})
        c.send({"type": "removed", "id": rec["id"], "name": rec["name"]})
        for x in list(self.conns(rec["id"])):
            x.send({"type": "kicked", "by": c.name})
            x.writer.close()

    # passkeys

    def passkey_domain(self, host):
        """The domain passkeys belong to at this address: config.json's passkeyDomain when the address is it or under
        it; with none set, the address itself; never an IP address (browsers refuse those)."""
        host = (host or "").lower()
        if not host or is_ip(host):
            return ""
        domain = str(self.cfg.get("passkeyDomain") or "").strip().lower().lstrip(".")
        if domain:
            return domain if host == domain or host.endswith("." + domain) else ""
        return host

    @staticmethod
    def _passkey_origin_ok(domain):
        """Which pages may use passkeys of this domain: secure ones at it or under it (http only on localhost)."""
        def ok(origin):
            parts = urlsplit(origin)
            name = (parts.hostname or "").lower()
            secure = parts.scheme == "https" or (parts.scheme == "http" and name == "localhost")
            return secure and (name == domain or name.endswith("." + domain))
        return ok

    def passkey_challenge(self, domain, kind, uid=None):
        """A one-time challenge for a passkey request (kind "get": signing in; "create": adding one), good for 5
        minutes; None when too many are waiting."""
        now = time.time()
        for key in [key for key, ask in self.passkey_asks.items() if ask["exp"] < now]:
            del self.passkey_asks[key]
        if len(self.passkey_asks) >= 5000:
            return None
        challenge = passkeys.b64url(secrets.token_bytes(32))
        self.passkey_asks[challenge] = {"exp": now + 300, "rp": domain, "kind": kind, "uid": uid}
        return challenge

    @staticmethod
    def _passkey_list(rec):
        return [{"id": p["id"], "name": p.get("name", "Passkey"), "created": p.get("created", 0), "used": p.get("used", 0)}
                for p in rec.get("passkeys", [])]

    def _passkey_answer(self, m, kind):
        """The challenge a passkey answer (credential) is for, taken off the list, and its decoded parts."""
        cred = m.get("credential") if isinstance(m.get("credential"), dict) else {}
        response = cred.get("response") if isinstance(cred.get("response"), dict) else {}
        try:
            parts = {key: passkeys.unb64url(response.get(key)) for key in ("clientDataJSON", "attestationObject", "authenticatorData", "signature")}
        except (ValueError, TypeError):
            return None, None, None
        challenge = passkeys.challenge_of(parts["clientDataJSON"])
        ask = self.passkey_asks.pop(challenge, None) if challenge else None
        if not ask or ask["kind"] != kind or ask["exp"] < time.time():
            return None, None, None
        return cred, parts, {**ask, "challenge": challenge}

    def on_passkey_begin(self, c, m):
        """Settings asks to add a passkey: what the device needs to make one for this account."""
        if c.passkey_create:
            self.passkey_asks.pop(c.passkey_create, None)   # Settings opened again: the last one was never used
        options = self._passkey_options(c.user, self.passkey_domain(c.host))
        c.passkey_create = options["challenge"] if options else None
        c.send({"type": "passkey-options", **({"options": options} if options else {"error": "Passkeys don't work at this address."})})

    def _passkey_options(self, rec, domain):
        """What a device needs to make a passkey for rec (with a new challenge), or None."""
        challenge = domain and self.passkey_challenge(domain, "create", rec["id"])
        if not challenge:
            return None
        return {
            "rp": {"id": domain, "name": "Umbryx"},
            "user": {"id": passkeys.b64url(rec["id"].encode()), "name": rec["name"], "displayName": rec.get("display") or rec["name"]},
            "challenge": challenge, "timeout": 120000, "attestation": "none",
            "pubKeyCredParams": [{"type": "public-key", "alg": passkeys.ES256}, {"type": "public-key", "alg": passkeys.RS256}],
            "authenticatorSelection": {"residentKey": "required", "requireResidentKey": True, "userVerification": "preferred"},
            "excludeCredentials": [{"type": "public-key", "id": p["id"]} for p in rec.get("passkeys", [])],
        }

    def on_passkey_finish(self, c, m):
        problem = self._passkey_add(c.user, m)
        if problem:
            c.send({"type": "error", "code": "passkey", "message": problem})

    def _passkey_add(self, rec, m):
        """Keeps the passkey a device made for rec (passkey-finish, or the browser link); tells rec's devices. Returns
        what went wrong, or None."""
        cred, parts, ask = self._passkey_answer(m, "create")
        if not ask or ask["uid"] != rec["id"]:
            return "That took too long. Try adding the passkey again."
        try:
            made = passkeys.verify_registration(parts["clientDataJSON"], parts["attestationObject"], ask["challenge"],
                                                ask["rp"], self._passkey_origin_ok(ask["rp"]))
        except (ValueError, IndexError, KeyError, TypeError) as err:
            return "The passkey wasn't added: %s." % err
        if any(p["id"] == made["id"] for r in self.users.values() for p in r.get("passkeys", [])):
            return "That passkey is on an account already."
        name = clean_text(m.get("name"), 40) or "Passkey"
        kept = rec.setdefault("passkeys", [])
        kept.append({**made, "rp": ask["rp"], "name": name, "created": int(time.time() * 1000), "used": 0})
        del kept[:-10]
        self._save_users()
        log("%s added a passkey (%s)" % (rec["name"], name))
        self.send_to(rec["id"], {"type": "passkeys", "passkeys": self._passkey_list(rec), "added": made["id"]})
        return None

    def _passkey_link_domain(self, c):
        """The passkey domain a browser link from this connection would use: the apps' address's, else this address's."""
        address = app_address(self.cfg)
        return (self.passkey_domain(urlsplit(address).hostname or "") if address else "") or self.passkey_domain(c.host)

    def on_passkey_link(self, c, m):
        """A one-time link to add a passkey to this account in a web browser (for an app that can't make one itself):
        good for 10 minutes. The page builds the address; the token goes after "#", so it's never in a request line."""
        if not self._passkey_link_domain(c):
            c.send({"type": "passkey-link", "error": "Passkeys aren't set up on this server."})
            return
        now = time.time()
        for token in [t for t, link in self.passkey_links.items() if link["exp"] < now]:
            del self.passkey_links[token]
        if len(self.passkey_links) >= 1000:
            c.send({"type": "passkey-link", "error": "Too many passkey links waiting. Try again in a few minutes."})
            return
        token = secrets.token_urlsafe(24)
        self.passkey_links[token] = {"uid": c.id, "exp": now + 600}
        c.send({"type": "passkey-link", "token": token})

    def on_passkey_remove(self, c, m):
        kept = c.user.get("passkeys", [])
        left = [p for p in kept if p["id"] != m.get("id")]
        if len(left) == len(kept):
            return
        c.user["passkeys"] = left
        self._save_users()
        log("%s removed a passkey" % c.name)
        self.send_to(c.id, {"type": "passkeys", "passkeys": self._passkey_list(c.user)})

    def _passkey_sign_in(self, c, m):
        """Signing in with a passkey (auth mode "passkey"): the account whose passkey signed this server's challenge."""
        cred, parts, ask = self._passkey_answer(m, "get")
        if not ask:
            self._auth_error(c, "passkey-login", "That passkey request expired. Try again.")
        found = next(((r, p) for r in self.users.values() if not r.get("deleted")
                      for p in r.get("passkeys", []) if p["id"] == cred.get("id") and p.get("rp") == ask["rp"]), None)
        if not found:
            self._auth_error(c, "passkey-login", "That passkey isn't on any account here. Sign in with your password, then add it in Settings.", count=True)
        rec, stored = found
        try:
            count = passkeys.verify_assertion(stored, parts["clientDataJSON"], parts["authenticatorData"], parts["signature"],
                                              ask["challenge"], ask["rp"], self._passkey_origin_ok(ask["rp"]))
        except (ValueError, IndexError, KeyError, TypeError) as err:
            self._auth_error(c, "passkey-login", "That passkey didn't work: %s." % err, count=True)
        stored["count"] = count
        stored["used"] = int(time.time() * 1000)
        log("%s signed in with a passkey" % rec["name"])
        return rec

    # push notifications (the iPhone app)

    def on_channel_notify(self, c, m):
        """Which messages in a text channel notify this account: "all", "mentions" (@mentions and replies) or "none";
        "default" goes back to the device's own setting. Kept on the account; all its devices hear."""
        ch, level = self.channel(m.get("channel"), "text"), m.get("level")
        if not ch or level not in ("all", "mentions", "none", "default") or c.user.get("guest"):
            return
        chosen = c.user.setdefault("channelNotify", {})
        if level == "default":
            chosen.pop(ch["id"], None)
        else:
            chosen[ch["id"]] = level
        self._save_users()
        self.send_to(c.id, {"type": "channel-notify", "channelNotify": chosen})

    def on_push_token(self, c, m):
        """The iPhone app's device token for push notifications ("remove": true when it signs out or turns them off).
        A device belongs to one account at a time."""
        token = str(m.get("token") or "").lower()
        if not re.fullmatch(r"[0-9a-f]{64,200}", token):
            return
        for rec in self.users.values():
            if any(t.get("token") == token for t in rec.get("pushTokens", [])):
                rec["pushTokens"] = [t for t in rec["pushTokens"] if t.get("token") != token]
        if m.get("remove") is not True:
            tokens = c.user.setdefault("pushTokens", [])
            tokens.append({"token": token, "sandbox": m.get("sandbox") is True, "added": int(time.time() * 1000),
                           "session": c.session_key})
            del tokens[:-10]
        self._save_users()

    def on_app_state(self, c, m):
        """The phone app went to the background (push notifications reach it) or came back (it shows things itself)."""
        c.background = m.get("state") == "background"

    def _push_ready(self):
        """(provider token, bundle id, sandbox) when push notifications are set up (config "apns" and its key file),
        else None. The token is remade every 50 minutes."""
        cfg = self.cfg.get("apns") if isinstance(self.cfg.get("apns"), dict) else {}
        team, key_id, bundle = (str(cfg.get(k) or "").strip() for k in ("teamId", "keyId", "bundleId"))
        key_file = str(cfg.get("keyFile") or "apns-key.p8")
        if not (team and key_id and bundle) or "/" in key_file or "\\" in key_file:
            return None
        now = time.time()
        if not self.push_auth or now - self.push_auth[1] > 50 * 60 or self.push_auth[2] != (team, key_id):
            try:
                d = p256.private_key_from_pem((DATA / key_file).read_text("ascii"))
                self.push_auth = (push.provider_token(team, key_id, d, now), now, (team, key_id))
            except (OSError, ValueError, StopIteration, IndexError) as err:
                if not self.push_warned:
                    self.push_warned = True
                    log("! push notifications are set up but the key could not be read (%s): check %s" % (type(err).__name__, key_file))
                return None
        return self.push_auth[0], bundle, cfg.get("sandbox") is True

    @staticmethod
    def _shown_name(viewer, rec):
        """rec's name as viewer sees it: their nickname for rec, else rec's display name, else the username."""
        return (viewer.get("nicknames") or {}).get(rec["id"]) or rec.get("display") or rec["name"]

    @staticmethod
    def _push_text(msg):
        text = re.sub(r"\s+", " ", msg.get("text") or "").strip()
        if text:
            return text if len(text) <= 240 else text[:237] + "..."
        files = msg.get("attachments") or []
        kinds = {str(a.get("type") or "").split("/")[0] for a in files}
        return "Sent a picture." if kinds == {"image"} else "Sent a video." if kinds == {"video"} else "Sent a file."

    def notify(self, rec, title, body, data, ping=False, call=False, thread=None, collapse=None):
        """A push notification to rec's iPhones, when push is set up and rec isn't looking already: nothing while
        they're on do-not-disturb (except a ping), or while a device of theirs is in use (the phone app open, or a
        computer they aren't away from)."""
        tokens = rec.get("pushTokens")
        if not tokens or rec.get("deleted") or (rec.get("status") == "dnd" and not ping):
            return
        if any(not x.idle and not x.background and not x.away for x in self.conns(rec["id"])):
            return
        ready = self._push_ready()
        if not ready:
            return
        token, bundle, sandbox_default = ready
        # The iPhone app's own sounds: its ring for calls, its message sound for messages, pings, mentions and replies;
        # the system's for missed calls and friend requests.
        sound = {"call": "incoming.caf", "dm": "message.caf", "ping": "message.caf", "mention": "message.caf",
                 "message": "message.caf"}.get(data.get("kind"), "default")
        aps = {"alert": {"title": title[:100], "body": body[:240]}, "sound": sound,
               "badge": sum(d["unread"] for d in self._dm_summaries(rec))}
        if thread:
            aps["thread-id"] = thread
        if call or ping:
            aps["interruption-level"] = "time-sensitive"
        # Which server it came from, so a phone with several opens the right one.
        payload = {"aps": aps, "umbryx": {**data, "server": app_address(self.cfg)}}
        loop = asyncio.get_running_loop()
        for entry in list(tokens):
            if entry.get("session") and entry["session"] not in self.sessions:
                continue   # registered by a sign-in that has ended (forget_session normally removes these)
            sandbox = entry.get("sandbox", sandbox_default)
            job = loop.run_in_executor(None, push.send, entry["token"], payload, bundle, token, sandbox, "alert", 10, collapse)
            job.add_done_callback(lambda done, rec=rec, entry=entry: self._pushed(rec, entry, done))

    def _pushed(self, rec, entry, done):
        try:
            status, reason = done.result()
        except (OSError, ConnectionError, ValueError) as err:
            log("! a push notification could not be sent (%s)" % err)
            return
        if reason in ("BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"):
            rec["pushTokens"] = [t for t in rec.get("pushTokens", []) if t is not entry]   # that phone is gone
            self._save_users()
        elif reason:
            log("! Apple refused a push notification: %s" % reason)

    # moderation: server mute, server deafen, ban

    def _moderated(self, c, m, verb):
        """The account an admin acts on (verb: "server mute", "ban"...), or None after saying why not. Not an admin
        or a canDeleteStaff account, not yourself."""
        if not self.can_manage(c.user):
            c.send({"type": "error", "code": "not-owner", "message": "Only the server's admins can %s people." % verb})
            return None
        rec = self.users.get(m.get("id"))
        if not rec or rec is c.user or rec.get("deleted"):
            return None
        if self.can_manage(rec) or self._listed(rec, "canDeleteStaff"):
            c.send({"type": "error", "code": "moderate", "message": "%s is one of the server's admins, and admins can't be muted, deafened, kicked or banned." % rec["name"]})
            return None
        return rec

    def _show_user(self, rec):
        """Tells everyone who may see rec how rec looks now."""
        for client in self.everyone():
            shown = self.public_for(client.user, rec)
            if shown:
                client.send({"type": "user-update", "user": shown})

    def _set_voice_lock(self, c, m, key, verb):
        rec = self._moderated(c, m, verb)
        if not rec:
            return
        on = m.get("on", True) is not False
        if bool(rec.get(key)) == on:
            return
        if on:
            rec[key] = True
        else:
            rec.pop(key, None)
        self._save_users()
        log("%s %s %s" % (c.name, ("%sed" % verb.replace("server ", "server-").rstrip("e")) if on else "lifted the %s of" % verb, rec["name"]))
        self._show_user(rec)

    def on_server_mute(self, c, m):
        """An admin mutes someone in voice (on: false takes it off). Their app keeps their microphone off, and
        everyone else's app does not play them."""
        self._set_voice_lock(c, m, "serverMuted", "server mute")

    def on_server_deafen(self, c, m):
        """An admin deafens someone in voice (on: false takes it off): their app plays nobody, and keeps them muted."""
        self._set_voice_lock(c, m, "serverDeafened", "server deafen")

    def on_ban(self, c, m):
        """An admin bans someone: out of the server (like a kick) for good, no invite code lets them back in until an
        admin unbans them (on_unban) or lets them in. They keep their account and their direct messages with friends."""
        rec = self._moderated(c, m, "ban")
        if not rec or rec.get("banned"):
            return
        rec["banned"] = {"by": c.user["id"], "at": int(time.time() * 1000)}
        was_member = not rec.get("guest")
        rec["guest"] = True
        self._save_users()
        log("%s banned %s from the server" % (c.name, rec["name"]))
        if was_member:
            for client in self.everyone():
                if client.id != rec["id"]:
                    shown = self.public_for(client.user, rec)
                    client.send({"type": "user-update", "user": shown} if shown else {"type": "user-hidden", "id": rec["id"]})
            for x in list(self.conns(rec["id"])):
                x.send({"type": "kicked", "by": c.name, "banned": True})
                x.writer.close()
        c.send({"type": "removed", "id": rec["id"], "name": rec["name"], "banned": True})
        self._send_bans()

    def on_unban(self, c, m):
        if not self.can_manage(c.user):
            c.send({"type": "error", "code": "not-owner", "message": "Only the server's admins can unban people."})
            return
        rec = self.users.get(m.get("id"))
        if not rec or not rec.pop("banned", None):
            return
        self._save_users()
        log("%s unbanned %s" % (c.name, rec["name"]))
        c.send({"type": "unbanned", "id": rec["id"], "name": rec["name"]})
        self._send_bans()

    def on_bans(self, c, m):
        if self.can_manage(c.user):
            self._send_bans(c)

    def _send_bans(self, only=None):
        """Who is banned, to every admin's devices (or only to one asking)."""
        name = lambda uid: (self.users.get(uid) or {}).get("name", "")
        listed = sorted(({"id": r["id"], "name": r["name"], "by": name(r["banned"].get("by")), "at": r["banned"].get("at", 0)}
                         for r in self.users.values() if isinstance(r.get("banned"), dict) and not r.get("deleted")),
                        key=lambda x: -x["at"])
        for client in ([only] if only else self.everyone()):
            if self.can_manage(client.user):
                client.send({"type": "bans", "bans": listed})

    # invite codes

    def _invite(self, code):
        """The invite with this code (any capitals, dashes or spaces, or a link ending in it) while it can still be
        used, else None."""
        text = re.sub(r"[?#].*$", "", str(code or "").strip()).rstrip("/")
        code = re.sub(r"[^A-Z0-9]", "", text.rsplit("/", 1)[-1].upper())
        found = next((x for x in self.invites if x["code"] == code), None) if code else None
        if not found or (found["expires"] and found["expires"] <= time.time()) or (found["max"] and found["uses"] >= found["max"]):
            return None
        return found

    def on_invite_info(self, c, m):
        """What an invite link in a message shows (its card): for a code that works, the server's name, picture,
        banner and partner check and how many are online and in it; else only that it does not work. Whether the one
        asking is in the server already (Joined) or banned comes along."""
        now = time.time()
        if len(c.invite_asks) == c.invite_asks.maxlen and now - c.invite_asks[0] < 60:
            return   # a page asks once per code; this many is someone guessing codes
        c.invite_asks.append(now)
        text = re.sub(r"[?#].*$", "", str(m.get("code") or "").strip()).rstrip("/")
        code = re.sub(r"[^A-Z0-9]", "", text.rsplit("/", 1)[-1].upper())[:12]
        invite = self._invite(code)
        if not invite:
            c.send({"type": "invite-info", "code": code, "valid": False})
            return
        members = [r for r in self.users.values() if not r.get("guest") and not r.get("deleted")]
        c.send({"type": "invite-info", "code": code, "valid": True,
                "serverName": self.cfg["serverName"], "serverIcon": self.cfg.get("serverIcon", ""),
                "serverBanner": self.cfg.get("serverBanner", ""), "serverPartner": bool(self.cfg.get("serverPartner")),
                "members": len(members), "online": sum(1 for r in members if self.conns(r["id"])),
                "member": not c.user.get("guest"), "banned": bool(c.user.get("banned"))})

    def _use_invite(self, invite, rec):
        invite["uses"] += 1
        invite["joined"] = (invite.get("joined") or [])[-49:] + [rec["id"]]
        self._send_invites()   # saves them; admins see who joined, and a used-up code go

    def _save_invites(self):
        now = time.time()   # used-up and run-out codes go
        self.invites = [x for x in self.invites if not (x["expires"] and x["expires"] <= now) and not (x["max"] and x["uses"] >= x["max"])]
        write_json(DATA / "invites.json", self.invites)

    def _send_invites(self, c=None, made=None):
        """The invite codes, to every admin's devices (made: the code just made, for the device that asked)."""
        self._save_invites()
        name = lambda uid: (self.users.get(uid) or {}).get("name", "")
        listed = [{"code": x["code"], "max": x["max"], "uses": x["uses"], "by": name(x["by"]),
                   "expires": int(x["expires"] * 1000) if x["expires"] else None,
                   "joined": [name(uid) for uid in x.get("joined", []) if name(uid)]} for x in self.invites]
        for client in self.everyone():
            if self.can_manage(client.user):
                client.send({"type": "invites", "invites": listed, **({"made": made} if made and client is c else {})})

    def _admin_only(self, c):
        if self.can_manage(c.user):
            return True
        c.send({"type": "error", "code": "not-owner", "message": "Only the server's admins can make invite codes."})
        return False

    def on_invites(self, c, m):
        if self._admin_only(c):
            self._send_invites()

    def on_invite_create(self, c, m):
        """An admin makes an invite code: good for 1, 5, 25 or any number of people, for 1, 7, 30 days or for good."""
        if not self._admin_only(c):
            return
        if len(self.invites) >= MAX_INVITES:
            c.send({"type": "error", "code": "invite", "message": "There are already %d invite codes. Delete some first." % MAX_INVITES})
            return
        uses = m.get("uses") if m.get("uses") in INVITE_USES and not isinstance(m.get("uses"), bool) else 1
        days = m.get("days") if m.get("days") in INVITE_DAYS and not isinstance(m.get("days"), bool) else 7
        while True:
            code = "".join(secrets.choice(INVITE_CHARS) for _ in range(8))
            if not any(x["code"] == code for x in self.invites):
                break
        self.invites.append({"code": code, "by": c.id, "created": int(time.time()), "expires": time.time() + days * 86400 if days else 0,
                             "max": uses, "uses": 0, "joined": []})
        log("%s made an invite code" % c.name)
        self._send_invites(c, made=code)

    def on_invite_delete(self, c, m):
        if self._admin_only(c):
            self.invites = [x for x in self.invites if x["code"] != m.get("code")]
            self._send_invites()

    def on_redeem(self, c, m):
        """A guest with an account joins the server with an invite code."""
        rec = c.user
        if not rec.get("guest"):
            return
        fails = self.auth_fails.get(c.ip)
        if fails and len(fails) == fails.maxlen and time.time() - fails[0] < 300:
            c.send({"type": "error", "code": "invite", "message": "Too many wrong codes. Wait a few minutes and try again."})
            return
        if not rec.get("hash"):
            c.send({"type": "error", "code": "invite", "message": "Make an account first: invite codes are for accounts with a password."})
            return
        if rec.get("banned"):
            c.send({"type": "error", "code": "banned", "message": "You are banned from this server. Only its admins can let you back in."})
            return
        invite = self._invite(m.get("code"))
        if not invite:
            self.auth_fails.setdefault(c.ip, deque(maxlen=10)).append(time.time())
            c.send({"type": "error", "code": "invite", "message": "That invite code is not valid, or has run out."})
            return
        self._use_invite(invite, rec)
        self._let_in(rec, "with an invite code")

    # deleting accounts

    def _listed(self, rec, key):
        """Whether config.json's list `key` names this account (by name, any capitals, or id)."""
        listed = self.cfg.get(key)
        return isinstance(listed, list) and any(str(a) == rec["id"] or str(a).casefold() == rec["name"].casefold() for a in listed)

    def may_delete(self, me, rec):
        """Whether me may delete rec's account: their own; as Umbryx Staff, anyone's but Staff's; as one of
        config.json's canDeleteStaff, anyone's. Nobody but themselves may delete a canDeleteStaff account."""
        if rec is me:
            return True
        if rec.get("deleted") or self._listed(rec, "canDeleteStaff"):
            return False
        if self._listed(me, "canDeleteStaff"):
            return True
        return "staff" in self.badges_of(me) and "staff" not in self.badges_of(rec)

    def on_account_delete(self, c, m):
        """Delete an account (see may_delete for whose). Your own is confirmed by typing your username and password (a
        guest without an account types only their username); someone else's, the app confirms with "are you sure?".
        Their messages stay, shown as Deleted user."""
        me = c.user
        rec = self.users.get(m.get("id")) if m.get("id") not in (None, me["id"]) else me
        if rec is None or rec.get("deleted"):
            return
        fails = self.auth_fails.get(c.ip)
        if fails and len(fails) == fails.maxlen and time.time() - fails[0] < 300:
            c.send({"type": "error", "code": "delete", "message": "Too many wrong tries. Wait a few minutes and try again."})
            return
        if not self.may_delete(me, rec):
            c.send({"type": "error", "code": "delete", "message": "You can't delete %s's account." % rec["name"]})
            return
        if rec is not me:
            self._delete_account(rec, me)
            return
        password = str(m.get("password") or "")
        password_ok = (hmac.compare_digest(hash_password(password, me["salt"]), me["hash"]) if me.get("hash")
                       else True)   # a guest without a password confirms with their name alone
        if clean_text(m.get("name"), 32).casefold() != rec["name"].casefold() or not password_ok:
            self.auth_fails.setdefault(c.ip, deque(maxlen=10)).append(time.time())
            c.send({"type": "error", "code": "delete", "message": "That username or password is not right."})
            return
        self._delete_account(rec, me)

    def _delete_account(self, rec, by):
        uid, old = rec["id"], rec["name"]
        log("%s's account was deleted%s" % (old, "" if by is rec else " by " + by["name"]))
        # Signed out everywhere, at once.
        for key in [k for k, v in self.sessions.items() if v == uid]:
            del self.sessions[key]
        for x in list(self.conns(uid)):
            x.send({"type": "account-deleted", "by": None if by is rec else by["name"]})
            x.writer.close()
        # Off everyone's friend lists, and nobody's nickname for them stays.
        touched = []
        for other in self.users.values():
            if uid in (other.get("nicknames") or {}):
                del other["nicknames"][uid]
            for key in ("friends", "incoming", "outgoing", "dndPings"):
                if uid in other.get(key, ()):
                    other[key].remove(uid)
                    if other not in touched:
                        touched.append(other)
        # What is left is a "Deleted user" for their messages to point at: no name, picture, profile or password.
        uploads = [rec.get("avatar"), rec.get("banner"), rec.get("plate"), (rec.get("theme") or {}).get("image")]
        uploads += [f.get("url") for f in rec.get("favorites", ()) if isinstance(f, dict)]
        self.users[uid] = {"id": uid, "name": DELETED_NAME, "deleted": True, "salt": "", "hash": "", "avatar": "", "banner": "",
                           "about": "", "friends": [], "incoming": [], "outgoing": [], "read": {}, "created": rec.get("created", 0)}
        if self.names.get(old.casefold()) is rec:
            del self.names[old.casefold()]
        self._forget_in_config(old, uid)
        self._scrub_messages(uid)
        self._save_users()
        self._release_uploads([u for u in uploads if isinstance(u, str) and u.startswith("/uploads/")])
        self.broadcast({"type": "user-update", "user": self.public(self.users[uid])})
        for other in touched:
            self.send_to(other["id"], {"type": "friends", **self._friend_lists(other)})

    def _forget_in_config(self, name, uid):
        """config.json's lists that named a deleted account let go of it, so nobody who takes the name gets them."""
        changed = False
        named = lambda who: str(who) == uid or str(who).casefold() == name.casefold()
        badges = self.cfg.get("badges")
        if isinstance(badges, dict):
            for key in [k for k in badges if named(k)]:
                del badges[key]
                changed = True
        for key in ("admins", "canDeleteStaff"):
            listed = self.cfg.get(key)
            if isinstance(listed, list) and any(named(who) for who in listed):
                self.cfg[key] = [who for who in listed if not named(who)]
                changed = True
        if named(self.cfg.get("autoLogin") or ""):
            self.cfg["autoLogin"] = ""
            changed = True
        if changed:
            save_config(self.cfg)

    def _scrub_messages(self, uid):
        """A deleted account's name in messages (theirs, and replies quoting them) becomes Deleted user."""
        def scrub(msgs):
            changed = False
            for msg in msgs:
                for part in (msg, msg.get("reply")):
                    if isinstance(part, dict) and part.get("uid") == uid and part.get("name") != DELETED_NAME:
                        part["name"] = DELETED_NAME
                        changed = True
            return changed
        for cid, msgs in self.messages.items():
            if scrub(msgs):
                self._rewrite(MESSAGES / (cid + ".jsonl"), msgs)
        for key, msgs in self.dms.items():
            if scrub(msgs):
                self._rewrite(DMS / (key + ".jsonl"), msgs)

    def _sign_in(self, c, rec, session):
        # An account can be signed in on several devices at once: the phone does not push the computer off.
        first = not self.conns(rec["id"])
        was_on = self.devices_of(rec["id"])
        guest = bool(rec.get("guest"))
        started = {room: int((time.monotonic() - t) * 1000) for room, t in self.voice_started.items()}
        if guest:   # only their own call's
            mine = {x["room"] for x in self.calls.values() if rec["id"] in (x["from"], x["to"])}
            started = {room: ago for room, ago in started.items() if room in mine}
        c.user = rec
        self.online.setdefault(rec["id"], []).append(c)
        self.tokens[c.token] = c
        c.send({
            "type": "welcome", "id": rec["id"], "token": c.token, "session": session,
            # Someone not in the server (a guest) learns nothing of it: not its name, picture, banner or partner check.
            "serverName": "Umbryx" if guest else self.cfg["serverName"], "channels": [] if guest else self.channels, "guest": guest,
            "hasPassword": bool(rec.get("hash")),   # false only for a guest who has not made an account
            "nicknames": rec.get("nicknames") or {},   # the nicknames this account gave its friends (only it sees them)
            # Whose accounts this one may delete besides its own (see may_delete): "all", "members" (not Staff) or "".
            "canDelete": "all" if self._listed(rec, "canDeleteStaff") else "members" if "staff" in self.badges_of(rec) else "",
            "users": [u for u in (self.public_for(rec, r) for r in self.users.values()) if u],
            "friends": self._friend_lists(rec), "dms": self._dm_summaries(rec),
            # People on do-not-disturb this account has already used its one ping on.
            "pinged": [r["id"] for r in self.users.values() if rec["id"] in r.get("dndPings", ())],
            "emojis": self.emojis, "favorites": rec.get("favorites", []), "theme": rec.get("theme"),
            # How long each voice channel and call has been going, in milliseconds. An age rather than a time
            # of day, so a device whose clock is off still shows the right timer.
            "voiceStarted": started,
            "serverIcon": "" if guest else self.cfg.get("serverIcon", ""), "serverBanner": "" if guest else self.cfg.get("serverBanner", ""),
            "serverPartner": not guest and bool(self.cfg.get("serverPartner")),
            "spotifyClientId": self.cfg.get("spotifyClientId", ""),
            "appAddress": app_address(self.cfg),   # where desktop apps should reach this server (see the page's offerMove)
            # This account's passkeys, and the domain passkeys belong to on this address ("" where they do not work).
            "passkeys": self._passkey_list(rec), "passkeyDomain": self.passkey_domain(c.host),
            "passkeyLink": bool(self._passkey_link_domain(c)),   # a passkey can be added in a browser (passkey-link)
            "push": bool(self._push_ready()),      # whether the iPhone app can have push notifications here
            # Per channel: "all", "mentions" or "none" (unset: the device's own default; pushes: mentions).
            "channelNotify": rec.get("channelNotify") or {},
            "blocked": rec.get("blocked") or [],   # who this account blocked (see on_block)
            "canModerate": self.can_moderate(rec),   # sees reports and may delete channel messages (see can_moderate)
            "searchHas": True,                     # search takes has: image, video, file or link (see on_search)
            "canManage": self.can_manage(rec), "build": page_build(),
            "iceServers": self.cfg["iceServers"], "maxUploadMB": self.cfg["maxUploadMB"],
        })
        if self.can_moderate(rec):
            self._send_reports(c)   # the open reports, so the admin's apps can say there are some
        # Calls that rang while this account was nowhere on, and nobody answered.
        if rec.get("missedCalls"):
            c.send({"type": "missed-calls", "calls": rec.pop("missedCalls")})
            self._save_users()
        # A call ringing for this account (opened from its push notification, say): this device can answer it.
        for call in self.calls.values():
            if call["to"] == rec["id"] and not call["active"]:
                c.send({"type": "call-incoming", "call": call["id"], "with": call["from"]})
            elif call["from"] == rec["id"] and not call["active"]:
                # The caller is back (a phone back from the background, say): "Calling..." again, and it can cancel.
                # A phone takes over from a phone (most likely itself, its old connection not yet timed out).
                old = call["caller"]
                if old not in self.conns(rec["id"]) or old.device == c.device == "mobile":
                    call["caller"] = c
                c.send({"type": "call-ringing", "call": call["id"], "with": call["to"],
                        **({} if call["caller"] is c else {"elsewhere": True})})
        if first:
            self.broadcast({"type": "user-join", "user": self.public(rec)}, skip=c)
            log("%s is online%s" % (rec["name"], " (guest)" if guest else ""))
        else:
            log("%s is online on another device too" % rec["name"])
            if self.devices_of(rec["id"]) != was_on:   # a kind of device they were not on yet
                self.broadcast({"type": "user-update", "user": self.public(rec)})

    def forget_session(self, key):
        """A sign-in session stops working (signed out, forgotten, or pushed out by newer ones); the push tokens
        registered with it go too, so a phone that signed out gets no more notifications."""
        uid = self.sessions.pop(key, None)
        rec = self.users.get(uid) if uid else None
        if rec and rec.get("pushTokens"):
            rec["pushTokens"] = [t for t in rec["pushTokens"] if t.get("session") != key]
        return uid

    def on_logout(self, c, m):
        self.forget_session(token_hash(m.get("session")))
        token = str(m.get("pushToken") or "").lower()
        if token and c.user:
            c.user["pushTokens"] = [t for t in c.user.get("pushTokens", []) if t.get("token") != token]
        self._save_users()
        raise Kick()

    def on_profile(self, c, m):
        rec = c.user
        name = clean_text(m.get("name"), 32)
        if name and name != rec["name"]:
            taken = self.names.get(name.casefold())
            if not USERNAME.match(name):
                c.send({"type": "error", "code": "rename", "message": "Usernames are 2 to 24 letters, numbers, spaces, dots, dashes or underscores."})
            elif (taken and taken is not rec) or name.casefold() == DELETED_NAME.casefold():
                c.send({"type": "error", "code": "rename", "message": "That username is taken. Try another one."})
            else:
                log("%s is now called %s" % (rec["name"], name))
                if self.auto_account() is rec:      # keep the automatic sign-in pointing at this account
                    self.cfg["autoLogin"] = name
                    save_config(self.cfg)
                self._rename_in_config(rec["name"], name)
                del self.names[rec["name"].casefold()]
                rec["name"] = name
                self.names[name.casefold()] = rec
        before = rec["avatar"]
        rec["avatar"] = profile_image(m.get("avatar"))
        if "avatarFit" in m or rec["avatar"] != before:   # a new picture starts without the old one's placement
            rec["avatarFit"] = avatar_fit(m.get("avatarFit")) if rec["avatar"] else None
        before = rec["banner"]
        rec["banner"] = profile_image(m.get("banner"))
        if "bannerFit" in m or rec["banner"] != before:   # placed in the editor like the picture
            rec["bannerFit"] = avatar_fit(m.get("bannerFit")) if rec["banner"] else None
        rec["about"] = clean_block(m.get("about"), 190)
        dropped = []
        if "plate" in m:   # the nameplate behind their name in lists
            before = rec.get("plate", "")
            rec["plate"] = clean_plate(m.get("plate"))
            if before.startswith("/uploads/") and before != rec["plate"]:
                dropped.append(before)
            if "plateFit" in m or rec["plate"] != before:   # an uploaded one placed in the picture editor, like banners
                rec["plateFit"] = avatar_fit(m.get("plateFit")) if rec["plate"].startswith("/uploads/") else None
        if "display" in m:   # the name shown instead of the username; empty shows the username
            rec["display"] = clean_text(m.get("display"), 32)
        if "color" in m:   # the colour their name is written in; empty means the automatic one
            color = str(m.get("color") or "").lower()
            rec["color"] = color if NAME_COLOR.match(color) else ""
        self._save_users()
        self._release_uploads(dropped)   # a replaced nameplate upload, unless something else uses it
        self.broadcast({"type": "user-update", "user": self.public(rec)})

    def _rename_in_config(self, old, new):
        """config.json's badges and admins name people: they follow a rename, so the old name, free again, gives
        whoever takes it nothing that was someone else's."""
        changed = False
        badges = self.cfg.get("badges")
        if isinstance(badges, dict):
            for key in [k for k in badges if str(k).casefold() == old.casefold()]:
                badges[new] = badges.pop(key)
                changed = True
        for key in ("admins", "canDeleteStaff"):
            listed = self.cfg.get(key)
            if isinstance(listed, list):
                for i, who in enumerate(listed):
                    if str(who).casefold() == old.casefold():
                        listed[i] = new
                        changed = True
        if changed:
            save_config(self.cfg)

    def on_nickname(self, c, m):
        """Give someone a nickname that only this account sees, on all its devices (empty removes it)."""
        rec, target = c.user, self.users.get(m.get("id"))
        if not target or target is rec or target.get("deleted"):
            return
        nicknames = rec.setdefault("nicknames", {})
        nickname = clean_text(m.get("nickname"), 32)
        if nickname:
            if target["id"] not in nicknames and len(nicknames) >= 500:
                c.send({"type": "error", "code": "nickname", "message": "You already have 500 nicknames. Remove some first."})
                return
            nicknames[target["id"]] = nickname
        else:
            nicknames.pop(target["id"], None)
        self._save_users()
        self.send_to(c.id, {"type": "nicknames", "nicknames": nicknames})

    def on_theme(self, c, m):
        """Change this account's colour theme. Only its own devices hear about it: nobody else sees it."""
        rec = c.user
        before = (rec.get("theme") or {}).get("image", "")
        rec["theme"] = clean_theme(m.get("theme"))
        self._save_users()
        if before and before != (rec["theme"] or {}).get("image", ""):
            self._release_uploads([before])   # the old background picture, unless something else uses it
        self.send_to(c.id, {"type": "theme", "theme": rec["theme"]})

    def on_server_update(self, c, m):
        """An admin (see can_manage) changes the server's name, picture or banner. Everyone sees the change at once."""
        if not self.can_manage(c.user):
            c.send({"type": "error", "code": "not-owner", "message": "Only the server's admins can change it."})
            return
        # Only what this person changed: two owners saving at once must not undo each other's changes.
        old = [self.cfg.get("serverIcon", ""), self.cfg.get("serverBanner", "")]
        if "name" in m:
            self.cfg["serverName"] = clean_text(m.get("name"), 40) or self.cfg["serverName"]
        if "icon" in m:
            self.cfg["serverIcon"] = profile_image(m.get("icon"))
        if "banner" in m:
            self.cfg["serverBanner"] = profile_image(m.get("banner"))
        if "spotifyClientId" in m:
            given = clean_text(m.get("spotifyClientId"), 40).lower()
            self.cfg["spotifyClientId"] = given if SPOTIFY_CLIENT_ID.match(given) else ""
        name = self.cfg["serverName"]
        save_config(self.cfg)
        self._release_uploads([u for u in old if u and u not in (self.cfg["serverIcon"], self.cfg["serverBanner"])])
        log("%s changed the server's settings" % c.name)
        self.broadcast({"type": "server", "serverName": name, "serverIcon": self.cfg["serverIcon"], "serverBanner": self.cfg["serverBanner"],
                        "serverPartner": bool(self.cfg.get("serverPartner")),
                        "spotifyClientId": self.cfg.get("spotifyClientId", "")})

    @staticmethod
    def _has(msg, kind):
        """Whether a message has a picture, a video, another file, or a link (search's has)."""
        if kind == "link":
            return bool(LINK_IN_TEXT.search(msg.get("text") or ""))
        kinds = [a.get("kind") for a in msg.get("attachments", ())]
        return any(k not in ("image", "video") for k in kinds) if kind == "file" else kind in kinds

    def on_search(self, c, m):
        """Find messages with every word given (in their text or a file's name), newest first, optionally only one
        person's, or only those with a picture, video, file or link (has). Whole words: "hi" doesn't find "this";
        "hi*" finds words starting with hi. Looks through every text channel and this account's own direct messages,
        never anyone else's. authors counts the matches by person whatever the from, so the app can offer them."""
        words = re.findall(r"[\w']+\*?", clean_text(m.get("q"), 120).casefold())[:8]
        author = m.get("from") if isinstance(m.get("from"), str) and m.get("from") in self.users else None
        has = m.get("has") if m.get("has") in SEARCH_HAS else None
        reply = {"type": "search-results", "seq": m.get("seq"), "results": [], "total": 0, "authors": {}}
        if not words and not author and not has:
            c.send(reply)
            return
        places = [(self.messages.get(ch["id"], []), {"channel": ch["id"]}) for ch in self.channels
                  if ch["type"] == "text" and not c.user.get("guest")]
        for key, msgs in self.dms.items():
            a, _, b = key.partition("_")
            if c.id in (a, b):
                places.append((msgs, {"dm": b if a == c.id else a}))
        found = []
        for msgs, where in places:
            for msg in msgs:
                if isinstance(msg.get("join"), int) or (has and not self._has(msg, has)):
                    continue
                if words:
                    text = " ".join([msg.get("text") or ""] + [str(x.get("name", "")) for x in msg.get("attachments", ())])
                    present = set(SEARCH_WORDS.findall(text.casefold()))
                    if not all(any(p.startswith(w[:-1]) for p in present) if w.endswith("*") else w in present for w in words):
                        continue
                uid = msg.get("uid")
                reply["authors"][uid] = reply["authors"].get(uid, 0) + 1
                if not author or uid == author:
                    found.append((msg["ts"], msg, where))
        found.sort(key=lambda item: item[0], reverse=True)
        reply["total"] = len(found)
        reply["results"] = [{**msg, **where} for _, msg, where in found[:MAX_SEARCH_RESULTS]]
        c.send(reply)

    def on_idle(self, c, m):
        """A device says it has been left alone for 20 minutes, or that someone is back. The account shows as
        idle only while all of its devices are, so a phone in use keeps it active."""
        before = all(x.idle for x in self.conns(c.id))
        c.idle = bool(m.get("idle"))
        if all(x.idle for x in self.conns(c.id)) != before:
            self.broadcast({"type": "user-update", "user": self.public(c.user)})

    def on_away(self, c, m):
        """A computer says nobody has used it for a few minutes (away: true), or that someone is back. While every
        device of an account is away, idle, or a phone in the background, pushes reach the phone (see notify)."""
        c.away = bool(m.get("away"))

    def on_activity(self, c, m):
        """A desktop app says what its person is playing now (a game, Spotify, or nothing)."""
        raw = m.get("activities")
        now = time.monotonic()
        acts = []
        for item in raw[:3] if isinstance(raw, list) else []:
            act = clean_activity(item)
            if act:
                elapsed, left = act.pop("elapsed"), act.pop("left")
                act["since"] = now - elapsed / 1000 if elapsed is not None else None
                act["until"] = now + left / 1000 if left is not None else None
                acts.append(act)
        before = self.activities_of(c.id)
        if same_activities(acts, c.activities):
            return
        c.activities, c.activities_at = acts, now
        if not same_activities(self.activities_of(c.id), before):
            self.broadcast({"type": "user-update", "user": self.public(c.user)})

    def on_embed(self, c, m):
        """The preview card for a link in a message (a YouTube video, a post on X). The answer comes when the lookup
        is done; looked-up previews are kept a while, so a link many people see is looked up once."""
        url = str(m.get("url") or "")[:500]
        target = embed_target(url)
        now = time.monotonic()
        while c.embed_asks and now - c.embed_asks[0] > 60:
            c.embed_asks.popleft()
        if not target:
            c.send({"type": "embed", "url": url, "embed": None})
            return
        if len(c.embed_asks) >= MAX_EMBED_ASKS:   # a long history full of links: the app asks again shortly
            c.send({"type": "embed", "url": url, "embed": None, "retry": True})
            return
        c.embed_asks.append(now)
        asyncio.ensure_future(self._send_embed(c, url, target))

    async def _send_embed(self, c, url, target):
        kept = self.embed_cache.get(target)
        if kept and kept[0] > time.monotonic():
            found = kept[1]
        else:
            lookup = self.embed_lookups.get(target)
            if lookup is None:
                lookup = asyncio.get_running_loop().run_in_executor(None, fetch_embed, *target)
                self.embed_lookups[target] = lookup
            try:
                found = await lookup
            finally:
                self.embed_lookups.pop(target, None)
            self.embed_cache[target] = (time.monotonic() + (EMBED_KEEP if found else EMBED_RETRY), found)
            if len(self.embed_cache) > 2000:
                for key in sorted(self.embed_cache, key=lambda k: self.embed_cache[k][0])[:500]:
                    del self.embed_cache[key]
        if found and found["kind"] == "youtube":
            found = {**found, "start": youtube_start(url), "vertical": "/shorts/" in url}
        c.send({"type": "embed", "url": url, "embed": found})

    def on_note(self, c, m):
        """Set, change or clear the custom status under your name. It can clear itself after a while."""
        rec = c.user
        text = clean_text(m.get("text"), 80)
        minutes = m.get("minutes")
        if isinstance(minutes, bool) or minutes not in NOTE_MINUTES:
            minutes = 0
        rec["note"] = text
        rec["noteUntil"] = int(time.time() * 1000) + minutes * 60000 if text and minutes else 0
        self._save_users()
        self.broadcast({"type": "user-update", "user": self.public(rec)})

    def on_echo(self, c, m):
        """Sends the client's timestamp straight back, so the app can show its ping to this server."""
        if isinstance(m.get("t"), (int, float)):
            c.send({"type": "echo", "t": m["t"]})

    # do not disturb

    def on_status(self, c, m):
        rec, value = c.user, m.get("value")
        if value not in ("online", "dnd") or rec.get("status", "online") == value:
            return
        rec["status"] = value
        rec["dndPings"] = []   # everyone gets their one ping back for the next do-not-disturb spell
        self._save_users()
        self.broadcast({"type": "user-update", "user": self.public(rec)})

    def on_dm_ping(self, c, m):
        """Alert someone who is on do-not-disturb anyway. Each person may do this once per spell."""
        target = self.users.get(m.get("to"))
        if not target or target is c.user or not self.may_reach(c.user, target) or not self.conns(target["id"]) \
                or target.get("status", "online") != "dnd":
            return
        used = target.setdefault("dndPings", [])
        if c.id in used:
            c.send({"type": "error", "code": "pinged",
                    "message": "You have already used your one ping for %s." % target["name"]})
            return
        used.append(c.id)
        self._save_users()
        self.send_to(target["id"], {"type": "ping", "from": c.id})
        self.send_to(c.id, {"type": "ping-sent", "to": target["id"]})
        self.notify(target, self._shown_name(target, c.user), "Pinged you while you are on Do Not Disturb.",
                    {"kind": "ping", "from": c.id}, ping=True, thread="dm-" + c.id)

    # friends

    @staticmethod
    def _friend_lists(rec):
        return {"friends": rec["friends"], "incoming": rec["incoming"], "outgoing": rec["outgoing"]}

    def _push_friends(self, *recs):
        self._save_users()
        for rec in recs:
            for other in recs:
                if other is not rec and (rec.get("guest") or other.get("guest")):   # see seen_by
                    shown = self.public_for(rec, other)
                    self.send_to(rec["id"], {"type": "user-update", "user": shown} if shown else {"type": "user-hidden", "id": other["id"]})
            self.send_to(rec["id"], {"type": "friends", **self._friend_lists(rec)})

    def _befriend(self, a, b):
        for one, other in ((a, b), (b, a)):
            for key in ("incoming", "outgoing"):
                if other["id"] in one[key]:
                    one[key].remove(other["id"])
            if other["id"] not in one["friends"]:
                one["friends"].append(other["id"])

    def on_friend_add(self, c, m):
        me = c.user
        if me.get("guest") and self.too_fast(c):
            return
        target = self.users.get(m.get("id")) or self.names.get(clean_text(m.get("name"), 32).casefold())
        if not target or target.get("deleted"):
            c.send({"type": "error", "code": "no-user", "message": "Nobody on this server has that username."})
            return
        if target is me or target["id"] in me["friends"] or target["id"] in me["outgoing"]:
            return
        if self.blocks(me, target):
            self._say_blocked(c, target, "Unblock them to add them as a friend.", "Your friend request couldn't be sent.")
            return
        if target["id"] in me["incoming"]:      # they already asked: this is a yes
            self._befriend(me, target)
        else:
            me["outgoing"].append(target["id"])
            target["incoming"].append(me["id"])
            self.notify(target, self._shown_name(target, me), "Sent you a friend request.", {"kind": "friend", "from": me["id"]})
        self._push_friends(me, target)

    def on_friend_accept(self, c, m):
        me, target = c.user, self.users.get(m.get("id"))
        if target and target["id"] in me["incoming"] and not self.blocks(me, target):
            self._befriend(me, target)
            self._push_friends(me, target)

    def on_friend_remove(self, c, m):
        """Unfriend, decline a request or cancel one you sent."""
        me, target = c.user, self.users.get(m.get("id"))
        if not target:
            return
        for one, other in ((me, target), (target, me)):
            for key in ("friends", "incoming", "outgoing"):
                if other["id"] in one[key]:
                    one[key].remove(other["id"])
        self._push_friends(me, target)

    # blocking and reporting

    def _say_blocked(self, c, other, blocker_text, blocked_text):
        """c tried to reach someone, and one of them blocked the other. The one who blocked is told to unblock first;
        the one blocked only that it didn't go through, as in Discord: nothing says they were blocked."""
        if other["id"] in (c.user.get("blocked") or ()):
            c.send({"type": "error", "code": "blocked", "id": other["id"], "message": "You blocked %s. %s" % (other["name"], blocker_text)})
        else:
            c.send({"type": "error", "code": "undelivered", "id": other["id"], "message": blocked_text})

    def _send_blocked(self, rec):
        self.send_to(rec["id"], {"type": "blocked", "blocked": rec.get("blocked") or []})

    def on_block(self, c, m):
        """Block someone: no more direct messages, calls, pings or friend requests either way, and you are no longer
        friends (requests either way go too). The apps hide their channel messages behind "Blocked message", and their
        @mentions and replies don't notify you. Your direct messages so far stay readable. They aren't told."""
        if m.get("blocked") is False:   # the iPhone app's way to unblock
            self.on_unblock(c, m)
            return
        me, target = c.user, self.users.get(m.get("id"))
        if not target or target is me or target.get("deleted"):
            return
        blocked = me.setdefault("blocked", [])
        if target["id"] in blocked:
            return
        if len(blocked) >= MAX_BLOCKED:
            c.send({"type": "error", "code": "block-limit", "message": "You can block up to %d people." % MAX_BLOCKED})
            return
        blocked.append(target["id"])
        for one, other in ((me, target), (target, me)):
            for key in ("friends", "incoming", "outgoing"):
                if other["id"] in one[key]:
                    one[key].remove(other["id"])
        for call in [x for x in self.calls.values() if {x["from"], x["to"]} == {me["id"], target["id"]}]:
            self._end_call(call, "ended", by=c)
        log("%s blocked %s" % (me["name"], target["name"]))
        self._push_friends(me, target)   # saves
        self._send_blocked(me)

    def on_unblock(self, c, m):
        blocked = c.user.get("blocked") or []
        if m.get("id") in blocked:
            blocked.remove(m["id"])
            other = self.users.get(m["id"])
            log("%s unblocked %s" % (c.name, (other or {}).get("name", "someone")))
            if other:
                self._push_friends(c.user, other)   # saves; between a guest and someone else, out of sight again
            else:
                self._save_users()
            self._send_blocked(c.user)

    def on_report(self, c, m):
        """Report someone to the server's admins, or one of their messages (message: its id, with channel, or dm: the
        other person in a direct message the reporter is in): why (reason, one of REPORT_REASONS) and, if they like,
        more words (text). The message is copied into the report as it is now, so deleting it later doesn't hide it.
        The iPhone app's shape works too: kind "message" (id: the message's) or "user" (user or id: the account's),
        and note for the words. Either way the answer is "reported"."""
        me = c.user
        reason = clean_text(m.get("reason"), 40).casefold() or "other"
        kind = m.get("kind")
        msg_id = m.get("id") if kind == "message" else None if kind == "user" else m.get("message")
        msg = ch = None
        if msg_id is not None:
            found = self._conversation(c, m)
            if not found:
                return
            msgs, _path, _other, ch = found
            msg = next((x for x in msgs if x["id"] == msg_id), None)
            if not msg or not msg.get("uid") or isinstance(msg.get("join"), int):
                return
        target = self.users.get(msg["uid"] if msg else m.get("user") or m.get("id"))
        if not target or target is me or target.get("deleted"):
            return
        now = time.time()
        recent = [t for t in self.report_times.get(me["id"], ()) if now - t < 3600]
        if len(recent) >= REPORTS_PER_HOUR:
            c.send({"type": "error", "code": "slow-down", "message": "You've sent a lot of reports lately. Try again in a while."})
            return
        if any(not r.get("closed") and r["by"] == me["id"] and r["user"] == target["id"]
               and (r.get("message") or {}).get("id") == (msg["id"] if msg else None) for r in self.reports):
            c.send({"type": "reported", "again": True})   # already reported, and still open
            return
        self.report_times[me["id"]] = recent + [now]
        report = {"id": secrets.token_hex(6), "at": int(now * 1000), "by": me["id"], "byName": me["name"],
                  "user": target["id"], "userName": target["name"], "reason": reason,
                  "text": clean_block(m.get("note") if m.get("note") is not None else m.get("text"), 1000)}
        if msg:
            report["message"] = {"id": msg["id"], "ts": msg["ts"], "text": msg.get("text", ""),
                                 "attachments": [dict(a) for a in msg.get("attachments", ())]}
            if ch:
                report["message"]["channel"] = ch["id"]
                report["where"] = "#" + ch["name"]
            else:
                report["message"]["dm"] = True
                report["where"] = "a direct message"
        self.reports.append(report)
        self._save_reports()
        log("%s reported %s (%s)" % (me["name"], target["name"], reason))
        c.send({"type": "reported"})
        self._send_reports(new=report)
        for admin in self.users.values():
            if admin is not target and admin is not me and self.can_moderate(admin):
                self.notify(admin, "New report", "%s reported %s: %s" % (me["name"], target["name"],
                                                                       REPORT_REASONS.get(reason, reason.capitalize())),
                            {"kind": "report", "report": report["id"]}, thread="reports")

    def _save_reports(self):
        cutoff = (time.time() - REPORT_KEEP_DAYS * 86400) * 1000
        kept = [r for r in self.reports if not ((r.get("closed") or {}).get("at", cutoff) < cutoff)]
        kept = kept[-1000:]
        gone = [a["url"] for r in self.reports if r not in kept for a in (r.get("message") or {}).get("attachments", ())]
        self.reports = kept
        write_json(DATA / "reports.json", self.reports)
        self._release_uploads(gone)

    def _send_reports(self, only=None, new=None):
        """The open reports, newest first, to every admin's devices (or only to one asking); nobody sees reports about
        themselves. new: the report just made, so the apps can say so."""
        shown = sorted((r for r in self.reports if not r.get("closed")), key=lambda r: -r["at"])
        for client in ([only] if only else self.everyone()):
            if self.can_moderate(client.user):
                event = {"type": "reports", "reports": [r for r in shown if r["user"] != client.id]}
                if new and client.id not in (new["user"], new["by"]):
                    event["new"] = new["id"]
                client.send(event)

    def on_reports(self, c, m):
        if self.can_moderate(c.user):
            self._send_reports(c)

    def on_report_close(self, c, m):
        """An admin (or Staff) is done with a report (dealt with it, or nothing to do): off everyone's list. Also
        called "report-done"."""
        if not self.can_moderate(c.user):
            return
        report = next((r for r in self.reports if r["id"] == m.get("id") and not r.get("closed")), None)
        if not report or report["user"] == c.id:
            return
        report["closed"] = {"by": c.id, "byName": c.name, "at": int(time.time() * 1000)}
        self._save_reports()
        log("%s closed %s's report about %s" % (c.name, report["byName"], report["userName"]))
        self._send_reports()

    # channel messages

    def on_chat(self, c, m):
        ch = self.channel(m.get("channel"), "text")
        if not ch or self.too_fast(c):
            return
        text = clean_block(m.get("text"), 4000)
        attachments = self._attachments(m.get("attachments"))
        if not text and not attachments:
            return
        self.seq += 1
        msg = {"id": self.seq, "channel": ch["id"], "uid": c.id, "name": c.name, "ts": int(time.time() * 1000), "text": text}
        if attachments:
            msg["attachments"] = attachments
        reply = self._reply_to(self.messages[ch["id"]], m.get("reply"))
        if reply:
            msg["reply"] = reply
        self.messages[ch["id"]].append(msg)
        self._append_line(MESSAGES / (ch["id"] + ".jsonl"), msg)
        self.broadcast({"type": "chat", "message": msg})
        # A push to whoever is @mentioned or replied to (not the writer, not guests: they cannot see channels).
        replied = (reply or {}).get("uid")
        for rec in self.users.values():
            if rec is c.user or rec.get("guest") or rec.get("deleted") or c.id in (rec.get("blocked") or ()):
                continue
            level = (rec.get("channelNotify") or {}).get(ch["id"], "mentions")   # see on_channel_notify
            if level == "none":
                continue
            if rec["id"] == replied:
                self.notify(rec, "%s replied" % self._shown_name(rec, c.user), self._push_text(msg) if text else "[attachment]",
                            {"kind": "mention", "channel": ch["id"], "id": msg["id"], "reply": True}, thread="ch-" + ch["id"])
            elif text and re.search(r"(?<![\w@])@" + re.escape(rec["name"]) + r"(?![\w])", text, re.I):
                self.notify(rec, "%s in #%s" % (self._shown_name(rec, c.user), ch["name"]), self._push_text(msg),
                            {"kind": "mention", "channel": ch["id"], "id": msg["id"]}, thread="ch-" + ch["id"])
            elif level == "all":
                self.notify(rec, "%s in #%s" % (self._shown_name(rec, c.user), ch["name"]), self._push_text(msg),
                            {"kind": "message", "channel": ch["id"], "id": msg["id"]}, thread="ch-" + ch["id"])

    def on_history(self, c, m):
        ch = self.channel(m.get("channel"), "text")
        if ch:
            c.send({"type": "history", "channel": ch["id"], **self._page(self.messages[ch["id"]], m.get("before"))})

    def on_typing(self, c, m):
        # "stop" is sent when someone empties the message box, so the note goes away at once.
        event = {"type": "typing", "id": c.id, "name": c.name, "stop": bool(m.get("stop"))}
        if m.get("dm"):
            other = self.users.get(m["dm"])
            if other and self.may_reach(c.user, other):
                self.send_to(other["id"], {**event, "dm": c.id})
        elif self.channel(m.get("channel"), "text") and not c.user.get("guest"):
            # Not to the typist's own other devices either, or they would say "you are typing".
            self.broadcast({**event, "channel": m["channel"]}, skip_user=c.id)

    # direct messages

    @staticmethod
    def _dm_key(a, b):
        return "_".join(sorted((a, b)))

    def _dm_summaries(self, rec):
        out = []
        for key, msgs in self.dms.items():
            pair = key.split("_")
            if rec["id"] not in pair or not msgs:
                continue
            other = pair[0] if pair[1] == rec["id"] else pair[1]
            closed = (rec.get("dmClosed") or {}).get(other)
            if closed and msgs[-1]["ts"] <= closed:
                continue   # closed, and nothing written since
            seen = rec["read"].get(other, 0)
            unread = sum(1 for msg in msgs if msg["uid"] == other and msg["id"] > seen)
            out.append({"with": other, "last": msgs[-1]["ts"], "unread": unread})
        return out

    def on_dm_send(self, c, m):
        target = self.users.get(m.get("to"))
        if target and target is not c.user and not target.get("deleted") and self.blocks(c.user, target):
            self._say_blocked(c, target, "Unblock them to send them messages.", "Your message couldn't be delivered.")
            return
        if not target or target is c.user or not self.may_reach(c.user, target) or self.too_fast(c):
            return
        text = clean_block(m.get("text"), 4000)
        attachments = self._attachments(m.get("attachments"))
        if not text and not attachments:
            return
        self.seq += 1
        msg = {"id": self.seq, "uid": c.id, "to": target["id"], "name": c.name, "ts": int(time.time() * 1000), "text": text}
        if attachments:
            msg["attachments"] = attachments
        key = self._dm_key(c.id, target["id"])
        reply = self._reply_to(self.dms.get(key, []), m.get("reply"))
        if reply:
            msg["reply"] = reply
        self.dms.setdefault(key, []).append(msg)
        self._append_line(DMS / (key + ".jsonl"), msg)
        self.send_to(c.id, {"type": "dm", "message": msg})   # the sender's other devices show it too
        self.send_to(target["id"], {"type": "dm", "message": msg})
        self.notify(target, self._shown_name(target, c.user), self._push_text(msg),
                    {"kind": "dm", "from": c.id, "id": msg["id"]}, thread="dm-" + c.id)

    def on_dm_history(self, c, m):
        other = self.users.get(m.get("with"))
        # A deleted account's old messages stay readable, and so do someone's you blocked (or who blocked you).
        if other and (other.get("deleted") or self.may_reach(c.user, other) or self.blocks(c.user, other)):
            msgs = self.dms.get(self._dm_key(c.id, other["id"]), [])
            c.send({"type": "dm-history", "with": other["id"], **self._page(msgs, m.get("before"))})

    # deleting and pinning messages

    def _unread_from(self, rec, other_id):
        seen = rec["read"].get(other_id, 0)
        msgs = self.dms.get(self._dm_key(rec["id"], other_id), [])
        return sum(1 for msg in msgs if msg["uid"] == other_id and msg["id"] > seen)

    def _release_uploads(self, urls):
        """Remove uploaded files from disk once no message, profile, emoji or favourite uses them."""
        urls = set(urls)
        if not urls:
            return
        for msgs in list(self.messages.values()) + list(self.dms.values()):
            for msg in msgs:
                urls -= {a["url"] for a in msg.get("attachments", ())}
        for rec in self.users.values():
            urls -= {rec["avatar"], rec["banner"], (rec.get("theme") or {}).get("image", ""), rec.get("plate", "")}
            urls -= {f["url"] for f in rec.get("favorites", ())}
        urls -= {e["url"] for e in self.emojis}
        urls -= {self.cfg.get("serverIcon", ""), self.cfg.get("serverBanner", "")}
        urls -= {a["url"] for r in self.reports for a in (r.get("message") or {}).get("attachments", ())}
        for url in urls:
            hit = UPLOAD_URL.match(url)
            if hit:
                with contextlib.suppress(OSError):
                    (UPLOADS / hit.group(1)).unlink()

    def _conversation(self, c, m):
        """The message list a request points at: a text channel, or a direct message thread with someone.

        Returns (messages, file, other person's account or None, channel or None), or None if there is no such place.
        """
        other = self.users.get(m.get("dm")) if m.get("dm") else None
        if other and other is not c.user:
            key = self._dm_key(c.id, other["id"])
            return self.dms.setdefault(key, []), DMS / (key + ".jsonl"), other, None
        ch = self.channel(m.get("channel"), "text")
        if not ch or c.user.get("guest"):
            return None
        return self.messages[ch["id"]], MESSAGES / (ch["id"] + ".jsonl"), None, ch

    @staticmethod
    def _rewrite(path, msgs):
        # History files are append-only logs, so changing or removing a line means writing the file again.
        temp = path.with_suffix(".tmp")
        with open(temp, "w", encoding="utf-8") as f:
            for msg in msgs:
                f.write(dumps(msg) + "\n")
        os.replace(temp, path)

    def _tell_conversation(self, c, other, ch, event):
        """Send an event about one message to everyone who can see it."""
        if other:
            self.send_to(c.id, {**event, "dm": other["id"]})
            extra = {"unread": self._unread_from(other, c.id)} if event["type"] == "message-deleted" else {}
            self.send_to(other["id"], {**event, "dm": c.id, **extra})
        else:
            self.broadcast({**event, "channel": ch["id"]})

    def on_message_delete(self, c, m):
        """Delete one of your own messages, from a channel or from a direct message thread. The server's admins may
        delete anyone's in a channel (a reported one, say)."""
        found = self._conversation(c, m)
        if not found:
            return
        msgs, path, other, ch = found
        msg = next((x for x in msgs if x["id"] == m.get("id")), None)
        if not msg or (msg.get("uid") != c.id and not (ch and self.can_moderate(c.user))):
            return
        if msg.get("uid") != c.id:
            log("%s deleted a message by %s in #%s" % (c.name, msg.get("name", "someone"), ch["name"]))
        msgs.remove(msg)
        self._rewrite(path, msgs)
        self._release_uploads(a["url"] for a in msg.get("attachments", ()))
        self._tell_conversation(c, other, ch, {"type": "message-deleted", "id": msg["id"]})

    def on_message_edit(self, c, m):
        """Change the text of one of your own messages. Its attachments stay as they are."""
        found = self._conversation(c, m)
        if not found or self.too_fast(c):
            return
        msgs, path, other, ch = found
        msg = next((x for x in msgs if x["id"] == m.get("id")), None)
        if not msg or msg.get("uid") != c.id:
            return
        text = clean_block(m.get("text"), 4000)
        if text == msg.get("text", "") or (not text and not msg.get("attachments")):
            return
        msg["text"] = text
        msg["edited"] = int(time.time() * 1000)
        # Replies carry a short quote of the message they answer, so keep those quotes in step.
        quote = self._reply_to(msgs, msg["id"])["text"]
        for x in msgs:
            if x.get("reply") and x["reply"].get("id") == msg["id"]:
                x["reply"]["text"] = quote
        self._rewrite(path, msgs)
        self._tell_conversation(c, other, ch, {"type": "message-edited", "id": msg["id"], "text": text,
                                               "edited": msg["edited"], "quote": quote})

    def on_message_pin(self, c, m):
        """Pin or unpin a message. Anyone who can see the conversation may do it."""
        found = self._conversation(c, m)
        if not found:
            return
        msgs, path, other, ch = found
        msg = next((x for x in msgs if x["id"] == m.get("id")), None)
        pinned = bool(m.get("pinned"))
        if not msg or bool(msg.get("pinned")) == pinned:
            return
        if pinned and sum(1 for x in msgs if x.get("pinned")) >= MAX_PINS:
            c.send({"type": "error", "code": "pins-full", "message": "This conversation already has %d pinned messages. Unpin one first." % MAX_PINS})
            return
        if pinned:
            msg["pinned"] = True
        else:
            msg.pop("pinned", None)
        self._rewrite(path, msgs)
        self._tell_conversation(c, other, ch, {"type": "message-pinned", "id": msg["id"], "pinned": pinned, "by": c.id})

    def on_pins(self, c, m):
        found = self._conversation(c, m)
        if not found:
            return
        msgs, _path, other, ch = found
        where = {"dm": other["id"]} if other else {"channel": ch["id"]}
        c.send({"type": "pins", **where, "messages": [x for x in msgs if x.get("pinned")]})

    # custom emoji and favourites

    def on_emoji_add(self, c, m):
        name = str(m.get("name") or "").strip().strip(":").lower()
        url = profile_image(m.get("url"))
        problem = None
        if not EMOJI_NAME.match(name):
            problem = "Emoji names are 2 to 32 lowercase letters, numbers or underscores."
        elif any(e["name"] == name for e in self.emojis):
            problem = "There is already an emoji called :%s:" % name
        elif not url:
            problem = "That file is not an image this server can use as an emoji."
        elif len(self.emojis) >= MAX_EMOJIS:
            problem = "This server already has the maximum of %d custom emoji." % MAX_EMOJIS
        if problem:
            c.send({"type": "error", "code": "emoji", "message": problem})
            return
        self.emojis.append({"name": name, "url": url, "by": c.id})
        write_json(DATA / "emojis.json", self.emojis)
        self.broadcast({"type": "emojis", "emojis": self.emojis})

    def on_emoji_remove(self, c, m):
        gone = next((e for e in self.emojis if e["name"] == m.get("name")), None)
        if not gone:
            return
        self.emojis.remove(gone)
        write_json(DATA / "emojis.json", self.emojis)
        self._release_uploads([gone["url"]])
        self.broadcast({"type": "emojis", "emojis": self.emojis})

    def on_favorite(self, c, m):
        """Add or remove a picture, GIF or video from your own favourites."""
        hit = UPLOAD_URL.match(str(m.get("url") or ""))
        favorites = c.user.setdefault("favorites", [])
        if not hit:
            return
        url = "/uploads/" + hit.group(1)
        kind = INLINE_TYPES.get((UPLOADS / hit.group(1)).suffix, "file/").split("/")[0]
        favorites[:] = [f for f in favorites if f["url"] != url]
        if m.get("on") and kind in ("image", "video") and (UPLOADS / hit.group(1)).is_file():
            favorites.insert(0, {"url": url, "name": clean_text(m.get("name"), 120) or "file", "kind": kind})
            del favorites[MAX_FAVORITES:]
        else:
            self._release_uploads([url])
        self._save_users()
        self.send_to(c.id, {"type": "favorites", "favorites": favorites})

    def on_dm_close(self, c, m):
        """Closing a direct message (the ✕ on its row) takes it off this account's list, read, until either of them
        writes again; "closed": false (opening it again) puts it back. Nothing is deleted. All the account's devices hear."""
        other = m.get("id")
        if other not in self.users or other == c.id:
            return
        closed = m.get("closed", True) is not False
        shut = c.user.setdefault("dmClosed", {})
        if closed:
            shut[other] = int(time.time() * 1000)
            msgs = self.dms.get(self._dm_key(c.id, other)) or []
            last = max((msg["id"] for msg in msgs if msg["uid"] == other), default=0)
            if last > c.user["read"].get(other, 0):
                c.user["read"][other] = last
        elif shut.pop(other, None) is None:
            return
        self._save_users()
        for x in self.conns(c.id):
            x.send({"type": "dm-closed", "id": other, "closed": closed})

    def on_dm_read(self, c, m):
        other, upto = m.get("with"), m.get("id")
        if other in self.users and isinstance(upto, int) and upto > c.user["read"].get(other, 0):
            c.user["read"][other] = upto
            self._save_users()

    # voice rooms

    def _call_room(self, room):
        return next((x for x in self.calls.values() if x["room"] == room), None)

    def on_voice_join(self, c, m):
        room = m.get("channel")
        call = self._call_room(room)
        allowed = (self.channel(room, "voice") and not c.user.get("guest")) or (call and call["active"] and c.id in (call["from"], call["to"]))
        if not allowed or c.voice == room:
            return
        previous = self._call_room(c.voice)
        # In voice on another device already: this one takes over, there and then. The other device is
        # told it was moved, and everyone in its room drops the connection they had to it before this
        # device calls them (this device itself is not told, or it would think it had been moved out).
        # When it is the same room, both updates say "moving", so the others swap connections without
        # the leave and join sounds.
        moved = next((x for x in self.conns(c.id) if x is not c and x.voice), None)
        left_call, moving = None, {}
        old_rooms = [c.voice, moved.voice if moved else None]
        if moved:
            left_call = self._call_room(moved.voice)
            moving = {"moving": True} if moved.voice == room else {}
            moved.voice, moved.sharing, moved.camera = None, False, False
            moved.send({"type": "voice-moved", "channel": room})
            self.broadcast({"type": "voice-update", "id": c.id, **NO_VOICE, **moving}, skip=c)
            log("%s moved voice to another device" % c.name)
        c.voice, c.sharing, c.camera = room, False, False
        c.muted, c.deafened = bool(m.get("muted")), bool(m.get("deafened"))
        # The newcomer calls everyone already in the room, so each pair connects exactly once.
        peers = [u.id for u in self.everyone() if u.voice == room and u.id != c.id]
        c.send({"type": "voice-joined", "channel": room, "peers": peers})
        if call:
            # The call may have been answered on another device: this one needs to know which call it is in.
            other = call["to"] if call["from"] == c.id else call["from"]
            c.send({"type": "call-joined", "call": call["id"], "room": room, "with": other})
        self.broadcast({"type": "voice-update", "id": c.id, **c.voice_state(), **moving})
        self._voice_rooms_changed(room, *old_rooms)
        if previous:
            self._end_call(previous, "ended", by=c)
        if left_call and left_call is not call:
            self._end_call(left_call, "ended", by=c)

    def on_voice_leave(self, c, m=None):
        if c.voice is None:
            return
        call = self._call_room(c.voice)
        room = c.voice
        c.voice, c.sharing, c.camera = None, False, False
        self.broadcast({"type": "voice-update", "id": c.id, **c.voice_state()})
        self._voice_rooms_changed(room)
        if call:
            self._end_call(call, "ended", by=c)

    def _voice_rooms_changed(self, *rooms):
        """Note when a voice channel or call gets its first person and forget it when the last one leaves, so
        everyone's timer counts from the same moment. ago is how long it has been going (None: it is empty)."""
        for room in {r for r in rooms if r}:
            occupied = any(u.voice == room for u in self.everyone())
            if occupied and room not in self.voice_started:
                self.voice_started[room] = time.monotonic()
                self.broadcast({"type": "voice-started", "room": room, "ago": 0})
            elif not occupied and self.voice_started.pop(room, None) is not None:
                self.broadcast({"type": "voice-started", "room": room, "ago": None})

    def on_voice_flags(self, c, m):
        if c.voice is None:
            return
        c.muted, c.deafened, c.sharing = bool(m.get("muted")), bool(m.get("deafened")), bool(m.get("sharing"))
        c.camera = bool(m.get("camera"))
        self.broadcast({"type": "voice-update", "id": c.id, **c.voice_state()})

    def on_signal(self, c, m):
        target = self.voice_conn(m.get("to"))
        if target and c.voice and target.voice == c.voice:
            target.send({"type": "signal", "from": c.id, "data": m.get("data")})

    # one-on-one calls: a private two-person voice room that is not a channel

    def on_call_invite(self, c, m):
        """A call, to a friend only (people who added each other). It rings even while they're offline: their phone
        through a push, and any device they open while it rings (see _sign_in); unanswered, it waits for them as a
        missed call (see _end_call)."""
        to = m.get("to")
        other = self.users.get(to) if isinstance(to, str) else None
        if not other or to == c.id or other.get("deleted"):
            return
        if to in (c.user.get("blocked") or ()):
            c.send({"type": "call-ended", "reason": "blocked", "with": to})
            return
        if to not in c.user.get("friends", ()) or not self.may_reach(c.user, other):
            c.send({"type": "call-ended", "reason": "not-friends", "with": to})
            return
        if any(c.id in (x["from"], x["to"]) or to in (x["from"], x["to"]) for x in self.calls.values()):
            c.send({"type": "call-ended", "reason": "busy", "with": to})
            return
        call = {"id": secrets.token_hex(6), "room": "call-" + secrets.token_hex(8),
                "from": c.id, "to": to, "active": False, "caller": c}
        call["timer"] = asyncio.get_running_loop().call_later(RING_SECONDS, self._call_timeout, call["id"])
        self.calls[call["id"]] = call
        # Every device of both people shows it: any of the caller's can cancel, any of the other's can answer.
        # Only the device that placed the call plays the ringback; the caller's others show it quietly.
        for x in self.conns(c.id):
            x.send({"type": "call-ringing", "call": call["id"], "with": to, **({} if x is c else {"elsewhere": True})})
        self.send_to(to, {"type": "call-incoming", "call": call["id"], "with": c.id})
        self.notify(other, self._shown_name(other, c.user), "Incoming call", {"kind": "call", "from": c.id, "call": call["id"]},
                    call=True, thread="call-" + c.id, collapse="call-" + call["id"])

    def on_call_answer(self, c, m):
        call = self.calls.get(m.get("call"))
        if not call or call["to"] != c.id or call["active"]:
            return
        call["timer"].cancel()
        if not m.get("accept"):
            self._end_call(call, "declined", by=c)
            return
        call["active"] = True
        # The call goes to the device that placed it and the one that answered. The other devices of both
        # stop ringing; they show the call as going on elsewhere, and can take it over from there.
        caller = call["caller"] if call["caller"] in self.conns(call["from"]) else next(iter(self.conns(call["from"])), None)
        for uid, keep in ((call["from"], caller), (call["to"], c)):
            for x in list(self.conns(uid)):
                if x is keep:
                    x.send({"type": "call-start", "call": call["id"], "room": call["room"]})
                else:
                    x.send({"type": "call-ended", "call": call["id"], "reason": "elsewhere"})

    def on_call_end(self, c, m):
        call = self.calls.get(m.get("call"))
        if call and c.id in (call["from"], call["to"]):
            self._end_call(call, "ended" if call["active"] else "cancelled", by=c)

    def _call_timeout(self, call_id):
        call = self.calls.get(call_id)
        if call and not call["active"]:
            self._end_call(call, "missed")

    def _end_call(self, call, reason, by=None):
        if self.calls.pop(call["id"], None) is None:
            return
        call["timer"].cancel()
        callee, caller = self.users.get(call["to"]), self.users.get(call["from"])
        if reason == "missed" and callee and caller and not self.conns(call["to"]):
            # Nobody answered and they weren't on: kept to tell them when they're next on (see _sign_in); their
            # phone's "Incoming call" notification becomes "Missed call".
            missed = callee.setdefault("missedCalls", [])
            missed.append({"from": call["from"], "at": int(time.time() * 1000)})
            del missed[:-20]
            self._save_users()
            self.notify(callee, self._shown_name(callee, caller), "Missed call", {"kind": "missed-call", "from": call["from"]},
                        thread="call-" + call["from"], collapse="call-" + call["id"])
        for uid in (call["from"], call["to"]):
            for user in list(self.conns(uid)):
                if user.voice == call["room"]:
                    self.on_voice_leave(user)
                user.send({"type": "call-ended", "call": call["id"], "reason": reason, "by": by.id if by else None})

    # channels

    def _channel_admin(self, c):
        """Making, renaming and deleting channels is for the server's admins (deleting a text channel deletes its
        messages)."""
        if self.can_manage(c.user):
            return True
        c.send({"type": "error", "code": "not-owner", "message": "Only the server's admins can make, rename or delete channels."})
        return False

    def on_channel_create(self, c, m):
        if not self._channel_admin(c):
            return
        kind = m.get("kind")
        name = clean_text(m.get("name"), 32)
        if kind not in ("text", "voice") or not name or len(self.channels) >= MAX_CHANNELS:
            return
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:24] or "channel"
        channel = {"id": "%s-%s" % (slug, secrets.token_hex(3)), "name": name, "type": kind}
        self.channels.append(channel)
        if kind == "text":
            self.messages[channel["id"]] = []
        write_json(DATA / "channels.json", self.channels)
        self.broadcast({"type": "channels", "channels": self.channels})
        log("%s created the %s channel %s" % (c.name, kind, name))

    def on_channel_rename(self, c, m):
        if not self._channel_admin(c):
            return
        channel = next((x for x in self.channels if x["id"] == m.get("id")), None)
        name = clean_text(m.get("name"), 32)
        if not channel or not name or name == channel["name"]:
            return
        log("%s renamed the channel %s to %s" % (c.name, channel["name"], name))
        channel["name"] = name   # the id stays the same, so messages and people in voice are unaffected
        write_json(DATA / "channels.json", self.channels)
        self.broadcast({"type": "channels", "channels": self.channels})

    def on_channel_delete(self, c, m):
        if not self._channel_admin(c):
            return
        channel = next((x for x in self.channels if x["id"] == m.get("id")), None)
        if not channel:
            return
        if channel["type"] == "text" and sum(1 for x in self.channels if x["type"] == "text") <= 1:
            c.send({"type": "error", "code": "last-channel", "message": "A server needs at least one text channel."})
            return
        self.channels.remove(channel)
        write_json(DATA / "channels.json", self.channels)
        if channel["type"] == "text":
            self.messages.pop(channel["id"], None)
            with contextlib.suppress(OSError):
                (MESSAGES / (channel["id"] + ".jsonl")).unlink()
        else:
            for user in self.everyone():
                if user.voice == channel["id"]:
                    self.on_voice_leave(user)
        self.broadcast({"type": "channels", "channels": self.channels})
        log("%s deleted the channel %s" % (c.name, channel["name"]))


# --- HTTP ----------------------------------------------------------------

class Request:
    __slots__ = ("method", "target", "headers")

    def __init__(self, method, target, headers):
        self.method, self.target, self.headers = method, target, headers


async def read_request(reader):
    try:
        raw = await reader.readuntil(b"\r\n\r\n")
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        return None
    lines = raw.decode("latin-1").split("\r\n")
    parts = lines[0].split(" ")
    if len(parts) != 3 or not parts[2].startswith("HTTP/1."):
        return None
    headers = {}
    for line in lines[1:]:
        key, sep, value = line.partition(":")
        if sep:
            headers[key.strip().lower()] = value.strip()
    return Request(parts[0].upper(), parts[1], headers)


def response_head(status, headers):
    lines = ["HTTP/1.1 %d %s" % (status, STATUS_TEXT.get(status, ""))]
    lines += ["%s: %s" % item for item in headers.items()]
    lines += ["X-Content-Type-Options: nosniff", "Referrer-Policy: no-referrer", "Connection: close", "", ""]
    return "\r\n".join(lines).encode("latin-1", "replace")


async def respond(writer, status, body=b"", content_type="text/plain; charset=utf-8", extra=None):
    if isinstance(body, str):
        body = body.encode("utf-8")
    headers = {"Content-Type": content_type, "Content-Length": len(body), "Cache-Control": "no-store"}
    headers.update(extra or {})
    writer.write(response_head(status, headers) + body)
    await writer.drain()


async def respond_json(writer, status, obj):
    await respond(writer, status, dumps(obj), "application/json")


def resolve_file(base, rel):
    if not rel or any(ch in rel for ch in "\\:\0"):
        return None
    try:
        path = (base / rel).resolve()
        path.relative_to(base.resolve())
    except (OSError, ValueError):
        return None
    return path if path.is_file() else None


async def serve_page(writer, req):
    """The page itself, its script and style addressed by the interface's fingerprint (page_build): a browser, or a
    cache in between such as Cloudflare, that kept an older copy of them can never run it with a newer page."""
    build = page_build()
    html = (PUBLIC / "index.html").read_text("utf-8")
    html = html.replace('href="/style.css"', 'href="/style.css?v=%s"' % build).replace('src="/app.js"', 'src="/app.js?v=%s"' % build)
    body = html.encode("utf-8")
    writer.write(response_head(200, {"Content-Type": STATIC_TYPES[".html"], "Content-Length": len(body), "Cache-Control": "no-cache",
                                     "Content-Security-Policy": APP_CSP}))
    if req.method != "HEAD":
        writer.write(body)
    await writer.drain()


async def serve_file(writer, req, base, rel, upload=False):
    path = resolve_file(base, rel)
    if not path:
        return await respond(writer, 404, "Not found")
    size = path.stat().st_size
    start, end, status = 0, size - 1, 200
    hit = re.match(r"bytes=(\d*)-(\d*)$", req.headers.get("range", "").strip())
    if hit and (hit.group(1) or hit.group(2)) and size:
        if hit.group(1):
            start = int(hit.group(1))
            end = min(int(hit.group(2)), size - 1) if hit.group(2) else size - 1
        else:
            start = max(0, size - int(hit.group(2)))
        if start > end:
            return await respond(writer, 416, "", extra={"Content-Range": "bytes */%d" % size})
        status = 206
    suffix = path.suffix.lower()
    headers = {"Content-Length": end - start + 1, "Accept-Ranges": "bytes"}
    if upload:
        # Uploads come from other users: never let them run as a page on this origin.
        headers["Content-Type"] = INLINE_TYPES.get(suffix, "application/octet-stream")
        headers["Content-Security-Policy"] = "sandbox; default-src 'none'; media-src 'self'; img-src 'self'"
        headers["Cache-Control"] = "private, max-age=31536000, immutable"
        if suffix not in INLINE_TYPES:
            headers["Content-Disposition"] = "attachment"
    else:
        headers["Content-Type"] = STATIC_TYPES.get(suffix, "application/octet-stream")
        headers["Cache-Control"] = "no-cache"
        if suffix == ".html":
            headers["Content-Security-Policy"] = APP_CSP
    if status == 206:
        headers["Content-Range"] = "bytes %d-%d/%d" % (start, end, size)
    writer.write(response_head(status, headers))
    if req.method != "HEAD":
        left = end - start + 1
        with open(path, "rb") as f:
            f.seek(start)
            while left > 0:
                chunk = f.read(min(65536, left))
                if not chunk:
                    break
                writer.write(chunk)
                await writer.drain()
                left -= len(chunk)
    await writer.drain()


async def handle_upload(hub, req, reader, writer):
    if req.headers.get("x-token") not in hub.tokens:
        return await respond_json(writer, 401, {"error": "Sign in again to upload files."})
    limit = int(float(hub.cfg["maxUploadMB"]) * 1024 * 1024)
    try:
        length = int(req.headers["content-length"])
    except (KeyError, ValueError):
        return await respond_json(writer, 411, {"error": "Missing file size."})
    if length > limit:
        return await respond_json(writer, 413, {"error": "That file is larger than %s MB." % hub.cfg["maxUploadMB"]})
    name = clean_text(parse_qs(urlsplit(req.target).query).get("name", ["file"])[0], 120) or "file"
    hit = re.search(r"\.([A-Za-z0-9]{1,8})$", name)
    stored = secrets.token_hex(12) + ("." + hit.group(1).lower() if hit else "")
    path = UPLOADS / stored
    left = length
    try:
        with open(path, "wb") as f:
            while left > 0:
                chunk = await asyncio.wait_for(reader.read(min(262144, left)), 30)
                if not chunk:
                    raise ConnectionError("upload interrupted")
                f.write(chunk)
                left -= len(chunk)
    except Exception:
        with contextlib.suppress(OSError):
            path.unlink()
        raise
    if await asyncio.to_thread(strip_location, path):   # before anyone can download it
        log("removed the photo location from an upload")
    await respond_json(writer, 200, {"url": "/uploads/" + stored, "name": name, "size": length})


async def handle_publish(hub, req, reader, writer, name):
    """Receives a new version of the desktop app from the publishing tool, one file at a time, and then its
    description (latest.json), which is what makes the apps see it. Every request carries the signed
    description, so nothing is stored unless the publisher's key signed it; a server cannot be handed a
    version that did not come from the publisher, or an older one again."""
    signed = signed_update(req.headers.get("x-update-manifest", ""), req.headers.get("x-update-signature", ""))
    if not signed:
        return await respond_json(writer, 403, {"error": "That update is not signed with the update key."})
    text, signature, manifest = signed
    current = published_update()
    if current and version_key(manifest["version"]) < version_key(current["version"]):
        return await respond_json(writer, 409, {"error": "Version %s is already published." % current["version"]})
    packages = list(manifest["packages"].values())

    if name == "latest.json":
        for p in packages:
            path = UPDATES / p["file"]
            if not path.is_file() or path.stat().st_size != p["size"] or await asyncio.to_thread(file_sha256, path) != p["sha256"]:
                return await respond_json(writer, 409, {"error": "%s has not been uploaded yet." % p["file"]})
        write_json(UPDATES / "latest.json", {"manifest": text.decode("utf-8"), "signature": base64.b64encode(signature).decode("ascii")})
        keep = {p["file"] for p in packages} | {"latest.json"}
        for old in UPDATES.iterdir():
            if old.is_file() and old.name not in keep:   # earlier versions' files and unfinished uploads
                with contextlib.suppress(OSError):
                    old.unlink()
        log("desktop app version %s is now offered as an update" % manifest["version"])
        # Open desktop apps fetch it straight away, so their green update arrow appears within seconds.
        hub.broadcast({"type": "app-update", "version": manifest["version"]})
        return await respond_json(writer, 200, {"version": manifest["version"]})

    package = next((p for p in packages if p["file"] == name), None)
    if not package:
        return await respond_json(writer, 404, {"error": "%s is not part of version %s." % (name, manifest["version"])})
    try:
        length = int(req.headers["content-length"])
    except (KeyError, ValueError):
        return await respond_json(writer, 411, {"error": "Missing file size."})
    if length != package["size"]:
        return await respond_json(writer, 400, {"error": "%s should be %d bytes." % (name, package["size"])})
    part = UPDATES / (name + ".part")
    digest, left = hashlib.sha256(), length
    try:
        with open(part, "wb") as f:
            while left > 0:
                chunk = await asyncio.wait_for(reader.read(min(262144, left)), 60)
                if not chunk:
                    raise ConnectionError("upload interrupted")
                f.write(chunk)
                digest.update(chunk)
                left -= len(chunk)
        if digest.hexdigest() != package["sha256"]:
            part.unlink()
            return await respond_json(writer, 400, {"error": "%s arrived damaged. Try again." % name})
        os.replace(part, UPDATES / name)
    except Exception:
        with contextlib.suppress(OSError):
            part.unlink()
        raise
    return await respond_json(writer, 200, {"stored": name})


async def handle_forget(hub, req, reader, writer):
    """Stop accepting a sign-in token. Knowing the token is the only proof needed to cancel it."""
    body = {}
    with contextlib.suppress(ValueError, asyncio.IncompleteReadError, asyncio.TimeoutError):
        length = int(req.headers.get("content-length", "0"))
        if 0 < length <= 2048:
            body = json.loads(await asyncio.wait_for(reader.readexactly(length), 10))
    if isinstance(body, dict) and hub.forget_session(token_hash(body.get("session"))):
        hub._save_users()
    await respond_json(writer, 200, {})


async def handle_passkey_link(hub, req, reader, writer, step):
    """The page a passkey link opens in a web browser (see Hub.on_passkey_link): "options" for making the passkey
    here, then "finish" with what the device made. The token (from the link) is the only key, used up on success."""
    body = {}
    with contextlib.suppress(ValueError, asyncio.IncompleteReadError, asyncio.TimeoutError):
        length = int(req.headers.get("content-length", "0"))
        if 0 < length <= 64 * 1024:
            body = json.loads(await asyncio.wait_for(reader.readexactly(length), 10))
    body = body if isinstance(body, dict) else {}
    ip = req.headers["x-forwarded-for"].split(",")[0].strip() if hub.cfg.get("trustProxy") and req.headers.get("x-forwarded-for") \
        else (writer.get_extra_info("peername") or ("?",))[0]
    asked = hub.passkey_ips.setdefault(ip, deque(maxlen=30))
    if len(asked) == asked.maxlen and time.time() - asked[0] < 60:
        return await respond_json(writer, 429, {"error": "Too many tries. Wait a minute."})
    asked.append(time.time())
    link = hub.passkey_links.get(str(body.get("token") or ""))
    rec = hub.users.get(link["uid"]) if link and link["exp"] > time.time() else None
    if not rec or rec.get("deleted"):
        return await respond_json(writer, 404, {"error": "This link has expired. Start again from Settings in Umbryx."})
    if step == "options":
        options = hub._passkey_options(rec, hub.passkey_domain(bare_host(req.headers.get("x-forwarded-host") or req.headers.get("host"))))
        if not options:
            return await respond_json(writer, 404, {"error": "Passkeys don't work at this address."})
        return await respond_json(writer, 200, {"options": options})
    problem = hub._passkey_add(rec, body)
    if problem:
        return await respond_json(writer, 400, {"error": problem})
    hub.passkey_links.pop(str(body.get("token")), None)
    return await respond_json(writer, 200, {"ok": True, "name": rec["name"]})


async def handle_http(hub, req, reader, writer):
    path = unquote(urlsplit(req.target).path)
    if req.method in ("GET", "HEAD"):
        if path == "/api/info":
            return await respond_json(writer, 200, {
                # Anyone can ask this, before signing in (the address may be public): the server's own name and
                # picture are only for those signed in, in the welcome.
                "serverName": "Umbryx", "serverIcon": "", "build": page_build(),
                "passwordRequired": bool(hub.cfg.get("password")), "guests": False,   # "Skip for now" is gone
                "inviteOnly": bool(hub.cfg.get("inviteOnly", True)),
                "httpsPort": hub.https_port,
                # Where the desktop app should reach this server, and the certificate it may know it by already
                # (so an app can tell that address leads here before moving to it).
                "appAddress": app_address(hub.cfg), "cert": cert_fingerprint(),
                # The domain passkeys belong to at this address ("" where they don't work: an IP address).
                "passkeys": hub.passkey_domain(bare_host(req.headers.get("x-forwarded-host") or req.headers.get("host"))),
                # Only a browser on the server computer is told about (or offered) the automatic sign-in.
                "autoLogin": hub.auto_account()["name"] if hub.auto_account() and is_local(req, writer) else "",
            })
        if path == "/api/passkey/options":
            # Signing in with a passkey: a challenge for this address's passkey domain (asked before signing in).
            domain = hub.passkey_domain(bare_host(req.headers.get("x-forwarded-host") or req.headers.get("host")))
            ip = req.headers["x-forwarded-for"].split(",")[0].strip() if hub.cfg.get("trustProxy") and req.headers.get("x-forwarded-for") \
                else (writer.get_extra_info("peername") or ("?",))[0]
            asked = hub.passkey_ips.setdefault(ip, deque(maxlen=30))
            if len(asked) == asked.maxlen and time.time() - asked[0] < 60:
                return await respond_json(writer, 429, {"error": "Too many passkey requests. Wait a minute."})
            asked.append(time.time())
            challenge = domain and hub.passkey_challenge(domain, "get")
            if not challenge:
                return await respond_json(writer, 404, {"error": "Passkeys don't work at this address."})
            return await respond_json(writer, 200, {"challenge": challenge, "rpId": domain, "timeout": 120000, "userVerification": "preferred"})
        if path == "/.well-known/apple-app-site-association":
            # The iPhone app (config "appleAppIds"): its passkeys for this domain, and invite links opening in it.
            ids = [str(x) for x in hub.cfg.get("appleAppIds") or [] if re.fullmatch(r"[A-Z0-9]{10}\.[A-Za-z0-9.-]+", str(x))]
            if not ids:
                return await respond(writer, 404, "Not found")
            return await respond_json(writer, 200, {"webcredentials": {"apps": ids},
                                                     "applinks": {"details": [{"appIDs": ids, "components": [
                                                         {"/": "/api/*", "exclude": True}, {"/": "/uploads/*", "exclude": True},
                                                         {"/": "/updates/*", "exclude": True}, {"/": "/*.*", "exclude": True},
                                                         {"/": "/????????", "comment": "invite links"}]}]}})
        if path.startswith("/uploads/"):
            return await serve_file(writer, req, UPLOADS, path[len("/uploads/"):], upload=True)
        if path.startswith("/updates/"):   # the desktop app's updates; each app checks the signature itself
            name = path[len("/updates/"):]
            if not UPDATE_FILE.match(name) or name.endswith(".part"):
                return await respond(writer, 404, "Not found")
            return await serve_file(writer, req, UPDATES, name)
        if path in ("/", "/index.html"):
            return await serve_page(writer, req)
        # An invite link (/K7QM2XPA): the page, which finds the code in its address.
        code = path[1:].rstrip("/")
        if len(code) == 8 and path.count("/") <= 2 and all(ch in INVITE_CHARS for ch in code.upper()):
            return await serve_page(writer, req)
        return await serve_file(writer, req, PUBLIC, path.lstrip("/"))
    if req.method == "POST" and path == "/api/upload":
        return await handle_upload(hub, req, reader, writer)
    if req.method == "POST" and path == "/api/forget":
        return await handle_forget(hub, req, reader, writer)
    if req.method == "POST" and path in ("/api/passkey/link-options", "/api/passkey/link-finish"):
        return await handle_passkey_link(hub, req, reader, writer, path.rsplit("-", 1)[1])
    if req.method == "PUT" and path.startswith("/updates/") and UPDATE_FILE.match(path[len("/updates/"):]):
        return await handle_publish(hub, req, reader, writer, path[len("/updates/"):])
    await respond(writer, 405, "Method not allowed")


async def handle_websocket(hub, req, reader, writer):
    host = req.headers.get("host", "").lower()
    forwarded = req.headers.get("x-forwarded-host", "").lower()
    origin = req.headers.get("origin")
    # Refuse sockets opened by other websites in the visitor's browser.
    if origin and urlsplit(origin).netloc.lower() not in (host, forwarded):
        return await respond(writer, 403, "Cross-origin WebSocket refused")
    key = req.headers.get("sec-websocket-key")
    if not key or req.headers.get("sec-websocket-version") != "13":
        return await respond(writer, 400, "Bad WebSocket handshake")
    accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
    writer.write((
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        "Sec-WebSocket-Accept: %s\r\n\r\n" % accept
    ).encode("ascii"))
    client = Client(writer)
    client.host = bare_host(forwarded or host)
    client.local = is_local(req, writer)
    client.device = device_of(req.headers.get("user-agent"))
    if hub.cfg.get("trustProxy") and req.headers.get("x-forwarded-for"):
        # Behind a reverse proxy every connection comes from the proxy, so count failed sign-ins per real visitor.
        client.ip = req.headers["x-forwarded-for"].split(",")[0].strip()
    hub.sockets.add(client)
    try:
        while True:
            text = await ws_read(reader, client)
            if text is None:
                break
            try:
                msg = json.loads(text)
            except ValueError:
                continue
            if isinstance(msg, dict):
                hub.dispatch(client, msg)
    except Kick:
        with contextlib.suppress(Exception):
            await writer.drain()
    finally:
        hub.drop(client)


async def on_connection(hub, reader, writer):
    try:
        req = await asyncio.wait_for(read_request(reader), 20)
        if req is None:
            return
        if req.headers.get("upgrade", "").lower() == "websocket":
            await handle_websocket(hub, req, reader, writer)
        else:
            await handle_http(hub, req, reader, writer)
    except (asyncio.TimeoutError, asyncio.IncompleteReadError, ConnectionError, ssl.SSLError, OSError):
        pass
    except Exception:
        traceback.print_exc()
        with contextlib.suppress(Exception):
            await respond(writer, 500, "Server error")
    finally:
        with contextlib.suppress(Exception):
            writer.close()
            await asyncio.wait_for(writer.wait_closed(), 5)


async def listen(hub, port, tls):
    try:
        return await asyncio.start_server(lambda r, w: on_connection(hub, r, w), None, port, ssl=tls)
    except OSError as err:
        print("  ! Port %d could not be opened (%s)." % (port, err))
        print("    Another program may be using it. Change the port in config.json and start again.")
        return None


async def main(args):
    global CONFIG_FILE
    if args.config:
        CONFIG_FILE = Path(args.config).resolve()
    cfg = load_config()
    use_data_dir(args.data or ROOT / "data")
    hub = Hub(cfg)
    named = public_hosts(cfg)
    # When the addresses are given (Docker, a domain name), those are what people use; otherwise guess the LAN ones.
    addresses = [] if named else lan_addresses()
    http_port = args.http or int(cfg["httpPort"])
    https_port = args.https or int(cfg["httpsPort"])

    print()
    plain = await listen(hub, http_port, None)
    tls = tls_context(addresses, named)
    secure = await listen(hub, https_port, tls) if tls else None
    hub.https_port = https_port if secure else None
    servers = [s for s in (plain, secure) if s]
    if not servers:
        return

    print("  %s is running." % cfg["serverName"])
    print()
    print("    On this computer      http://localhost:%d" % http_port)
    if secure:
        for ip in named or addresses or ["<this computer's IP address>"]:
            print("    Other devices         https://%s:%d" % (ip, https_port))
        print()
        print("    The first visit to an https address shows a certificate warning.")
        print("    Choose Advanced, then Continue. That is expected for a home server.")
    if cfg.get("password"):
        print("    New accounts need the server password from config.json.")
    if hub.auto_account():
        print("    On this computer the app opens signed in as %s." % hub.auto_account()["name"])
    elif cfg.get("autoLogin"):
        print("  ! autoLogin in config.json names an account that does not exist: %s" % cfg["autoLogin"])
    print()
    print("  Leave this window open. Press Ctrl+C to stop the server.")
    print()

    def quiet(loop, context):
        # A visitor's connection vanishing mid-close is routine, not something to print a traceback for.
        if not isinstance(context.get("exception"), ConnectionError):
            loop.default_exception_handler(context)

    asyncio.get_running_loop().set_exception_handler(quiet)
    heartbeat = asyncio.create_task(hub.heartbeat())
    try:
        await asyncio.gather(*(s.serve_forever() for s in servers))
    finally:
        heartbeat.cancel()


if __name__ == "__main__":
    if sys.version_info < (3, 9):
        sys.exit("Umbryx needs Python 3.9 or newer.")
    with contextlib.suppress(Exception):
        sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description="Umbryx voice, chat and screen-share server")
    parser.add_argument("--config", help="settings file to use (default: ./config.json)")
    parser.add_argument("--data", help="folder for accounts, messages and uploads (default: ./data)")
    parser.add_argument("--http", type=int, help="override httpPort from config.json")
    parser.add_argument("--https", type=int, help="override httpsPort from config.json")
    try:
        asyncio.run(main(parser.parse_args()))
    except KeyboardInterrupt:
        print("\n  Server stopped.")
