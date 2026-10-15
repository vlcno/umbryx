"""How many tokens building Umbryx has taken so far, and what they would cost at Anthropic's API prices: the number in
the middle of the app's top strip ("1,101,469,658 tokens ($319.63 USD)"). Run it before each update goes out.

It adds up every Claude Code conversation recorded for this project folder (each API request once, helper agents
included) and writes server/public/build-cost.json, which the page reads. The conversations are only read and
counted: nothing in them is followed or copied.

    python tools/build_cost.py [--projects DIR]

Prices are per million tokens, by model (fast mode doubles them); cache reads and the two kinds of cache writes are
priced as Anthropic prices them. A model missing from PRICES is priced as Claude Opus 5.5 and named in the output.
"""
import argparse
import json
import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Claude Code keeps a project's conversations in a folder named after the project's path.
DEFAULT_PROJECTS = Path(os.path.expanduser("~")) / ".claude" / "projects" / "".join(c if c.isalnum() else "-" for c in str(ROOT))
# $ per million tokens: input, output, cache read, cache write (5 minutes), cache write (1 hour)
PRICES = {
    "claude-opus-5-5": (4.00, 20.00, 0.20, 5.00, 8.00),
}
FALLBACK = "claude-opus-5-5"
# The Claude plan the work runs on, shown after the model in the top strip.
PLAN = "Max 20x $200 a month"


def model_name(model_id):
    """claude-opus-5-5 -> Claude Opus 5.5 (a family name, then its version numbers joined by dots)."""
    parts = [p for p in str(model_id).split("-") if p]
    words = [p.capitalize() for p in parts if not p.isdigit()]
    numbers = [p for p in parts if p.isdigit() and len(p) < 4]   # not a date
    return " ".join(words + ([".".join(numbers)] if numbers else [])) or "Claude"


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--projects", type=Path, default=DEFAULT_PROJECTS, help="the project's Claude Code conversations folder")
    args = parser.parse_args()
    seen = set()
    tokens = 0
    usd = 0.0
    unpriced = set()
    per_model = {}            # model id -> tokens
    latest = ("", "", "")     # (time, model id, speed) of the newest request
    for path in sorted(args.projects.rglob("*.jsonl")):
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                message = entry.get("message")
                if entry.get("type") != "assistant" or not isinstance(message, dict) or message.get("model") == "<synthetic>":
                    continue
                key = message.get("id") or entry.get("requestId") or entry.get("uuid")
                if key in seen:   # one request is recorded once per part of its answer
                    continue
                seen.add(key)
                usage = message.get("usage") or {}
                model = message.get("model", "")
                if model not in PRICES:
                    unpriced.add(model)
                p_in, p_out, p_read, p_w5, p_w60 = PRICES.get(model, PRICES[FALLBACK])
                speed = 2 if usage.get("speed") == "fast" else 1
                plain = usage.get("input_tokens", 0) or 0
                out = usage.get("output_tokens", 0) or 0
                read = usage.get("cache_read_input_tokens", 0) or 0
                write = usage.get("cache_creation_input_tokens", 0) or 0
                split = usage.get("cache_creation") or {}
                write_60 = split.get("ephemeral_1h_input_tokens", 0) or 0
                write_5 = split.get("ephemeral_5m_input_tokens", 0) or 0
                if write_5 + write_60 < write:   # no breakdown recorded: count the rest at the 5-minute price
                    write_5 += write - write_5 - write_60
                tokens += plain + out + read + write
                per_model[model] = per_model.get(model, 0) + plain + out + read + write
                when = entry.get("timestamp", "")
                if when >= latest[0]:
                    latest = (when, model, usage.get("speed") or "standard")
                usd += speed * (plain * p_in + out * p_out + read * p_read + write_5 * p_w5 + write_60 * p_w60) / 1e6
    result = {"tokens": tokens, "usd": round(usd, 2), "requests": len(seen),
              # the model that did the most recent work, and every model's share
              "model": model_name(latest[1]), "fast": latest[2] == "fast", "plan": PLAN,
              "models": {model_name(m): n for m, n in sorted(per_model.items(), key=lambda kv: -kv[1])},
              "updated": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    out_path = ROOT / "server" / "public" / "build-cost.json"
    out_path.write_text(json.dumps(result, indent=2) + "\n", "utf-8")
    print("%s tokens ($%.2f USD) over %d requests, latest by %s%s -> %s" % (format(tokens, ","), usd, len(seen), result["model"],
          " (fast)" if result["fast"] else "", out_path.relative_to(ROOT)))
    if unpriced:
        print("priced as %s (not in PRICES): %s" % (FALLBACK, ", ".join(sorted(unpriced))))


if __name__ == "__main__":
    main()
