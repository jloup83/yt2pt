#!/usr/bin/env python3
"""yt2pt — Download YouTube videos with full metadata, subtitles, and channel info."""

import argparse
import json
import os
import platform
import shutil
import ssl
import subprocess
import sys
import urllib.request
from pathlib import Path

VERSION = "v2.0.0-beta"
SCRIPT_DIR = Path(__file__).resolve().parent
DOWNLOADS_DIR = SCRIPT_DIR / "downloads"
LIST_FILE = SCRIPT_DIR / "list.txt"


# ── Colors ────────────────────────────────────────────────────────────────────

class C:
    """ANSI color codes (disabled when stdout is not a TTY)."""
    RESET = BOLD = DIM = RED = GREEN = YELLOW = BLUE = MAGENTA = CYAN = ""

if sys.stdout.isatty():
    C.RESET   = "\033[0m"
    C.BOLD    = "\033[1m"
    C.DIM     = "\033[2m"
    C.RED     = "\033[91m"
    C.GREEN   = "\033[92m"
    C.YELLOW  = "\033[93m"
    C.BLUE    = "\033[94m"
    C.MAGENTA = "\033[95m"
    C.CYAN    = "\033[96m"


# ── Logging ───────────────────────────────────────────────────────────────────

def log_info(msg):
    print(f"  {C.BLUE}ℹ{C.RESET}  {msg}")

def log_ok(msg):
    print(f"  {C.GREEN}✔{C.RESET}  {msg}")

def log_warn(msg):
    print(f"  {C.YELLOW}⚠{C.RESET}  {msg}")

def log_error(msg):
    print(f"  {C.RED}✖{C.RESET}  {msg}")

def log_cmd(cmd_list):
    print(f"  {C.MAGENTA}${C.RESET} {C.DIM}{' '.join(cmd_list)}{C.RESET}")

def log_step(msg):
    print(f"\n  {C.BOLD}{C.CYAN}▸ {msg}{C.RESET}")

def log_header(msg):
    bar = "═" * 64
    print(f"\n{C.BOLD}{bar}{C.RESET}")
    print(f"  {C.BOLD}{msg}{C.RESET}")
    print(f"{C.BOLD}{bar}{C.RESET}")


# ── Helpers ───────────────────────────────────────────────────────────────────

def get_ytdlp_binary():
    """Find the platform-specific yt-dlp binary in the script directory."""
    system = platform.system().lower()
    if system == "darwin":
        prefix = "yt-dlp-macos"
    elif system == "linux":
        prefix = "yt-dlp-linux"
    else:
        log_error(f"Unsupported platform: {system}")
        sys.exit(1)

    binaries = sorted(SCRIPT_DIR.glob(f"{prefix}*"))
    if not binaries:
        log_error(f"No yt-dlp binary found matching '{prefix}*' in {SCRIPT_DIR}")
        sys.exit(1)

    binary = binaries[-1]  # latest version
    if not os.access(binary, os.X_OK):
        os.chmod(binary, 0o755)
        log_info(f"Made {binary.name} executable")

    log_info(f"Using yt-dlp: {C.CYAN}{binary.name}{C.RESET}")
    return str(binary)


def sanitize_filename(name, max_length=100):
    """Replace filesystem-unsafe characters and limit length."""
    for ch in r'\/:*?"<>|':
        name = name.replace(ch, "_")
    # Collapse repeated underscores / spaces
    while "__" in name:
        name = name.replace("__", "_")
    name = name.strip(" ._")
    if len(name) > max_length:
        name = name[:max_length].rstrip(" ._")
    return name


def ensure_list_file():
    """Create list.txt with instructions if it doesn't exist, then exit."""
    if LIST_FILE.exists():
        return
    content = (
        "# yt2pt — YouTube video URL list\n"
        "#\n"
        "# Add one YouTube video URL per line.\n"
        "# Lines starting with '#' are comments and will be ignored.\n"
        "# Empty lines are also ignored.\n"
        "#\n"
        "# Example:\n"
        "# https://www.youtube.com/watch?v=eot4NJwbr3M\n"
    )
    LIST_FILE.write_text(content)
    print(f"\n  {C.YELLOW}⚠  list.txt was missing — created with instructions.{C.RESET}")
    print(f"  {C.YELLOW}   Add your YouTube URLs to list.txt and run again.{C.RESET}\n")
    sys.exit(1)
    log_ok(f"Created {C.CYAN}{LIST_FILE.name}{C.RESET} — add your video URLs and run again")


def read_urls():
    """Return a list of (line_number, url) from list.txt, skipping comments."""
    urls = []
    for lineno, line in enumerate(LIST_FILE.read_text().splitlines(), 1):
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            urls.append((lineno, stripped))
    return urls


def run_ytdlp(binary, args):
    """Run yt-dlp, log the full command, and return the CompletedProcess."""
    cmd = [binary] + args
    log_cmd(cmd)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 and result.stderr:
        for line in result.stderr.strip().splitlines()[:15]:
            log_error(f"  {line}")
    return result


def _get_ssl_context():
    """Build an SSL context that works on macOS Python.org installs."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    ctx = ssl.create_default_context()
    try:
        ctx.load_default_certs()
    except Exception:
        pass
    # If system certs are still broken, fall back to unverified
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def download_image(url, dest):
    """Download an image from a URL to a local path."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "yt2pt/1.0"})
        ctx = _get_ssl_context()
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            data = resp.read()
        dest.write_bytes(data)
        log_ok(f"Saved {C.CYAN}{dest.name}{C.RESET}")
        return True
    except Exception as e:
        log_warn(f"Could not download {dest.name}: {e}")
        return False


# ── Core logic ────────────────────────────────────────────────────────────────

def fetch_video_metadata(binary, url):
    """Fetch full video metadata via yt-dlp --dump-json."""
    log_step("Fetching video metadata")
    result = run_ytdlp(binary, ["--dump-json", "--no-download", url])
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        log_error("Failed to parse video metadata JSON")
        return None


def fetch_channel_metadata(binary, channel_url, cache):
    """Fetch channel metadata via yt-dlp. Results are cached by channel URL."""
    if channel_url in cache:
        log_info("Using cached channel metadata")
        return cache[channel_url]

    log_step("Fetching channel metadata")

    # Try --dump-single-json with --flat-playlist to get the playlist wrapper
    # which contains channel thumbnails (avatar, banner).
    result = run_ytdlp(binary, [
        "--dump-single-json",
        "--flat-playlist",
        "--playlist-items", "1",
        channel_url,
    ])

    meta = None
    if result.returncode == 0 and result.stdout.strip():
        try:
            meta = json.loads(result.stdout)
        except json.JSONDecodeError:
            pass

    cache[channel_url] = meta
    return meta


def pick_thumbnail(thumbnails, keyword):
    """Find the highest-resolution thumbnail whose 'id' contains the keyword."""
    hits = [t for t in thumbnails if keyword in (t.get("id") or "").lower()]
    if not hits:
        return None
    hits.sort(key=lambda t: (t.get("width") or 0) * (t.get("height") or 0), reverse=True)
    return hits[0].get("url")


def process_video(binary, url, channel_cache):
    """Download a single video with all associated assets."""

    # ── 1. Video metadata ────────────────────────────────────────────────────
    meta = fetch_video_metadata(binary, url)
    if not meta:
        log_error(f"Skipping {url} — could not fetch metadata")
        return False

    channel_name = sanitize_filename(meta.get("channel") or meta.get("uploader") or "Unknown")
    raw_date = meta.get("upload_date") or "19700101"
    # Build date + time string: 2026-04-16 - 20h09
    timestamp = meta.get("timestamp")
    if timestamp:
        from datetime import datetime, timezone
        dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)
        pub_date = dt.strftime("%Y-%m-%d")
        pub_time = dt.strftime("%Hh%M")
    else:
        pub_date = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:8]}"
        pub_time = None
    title = sanitize_filename(meta.get("title") or "Untitled")

    if pub_time:
        folder_name = f"{channel_name} - {pub_date} - {pub_time} - {title}"
    else:
        folder_name = f"{channel_name} - {pub_date} - {title}"

    video_dir     = DOWNLOADS_DIR / channel_name / folder_name
    metadata_dir  = video_dir / "metadata"
    video_meta    = metadata_dir / "video"
    subs_dir      = video_meta / "subtitles"
    channel_dir   = metadata_dir / "channel"

    # ── 2. Skip / overwrite check ────────────────────────────────────────────
    complete_marker = video_dir / "COMPLETE"
    if video_dir.exists():
        if complete_marker.exists():
            # Completed download — default to skip
            answer = input(
                f"  {C.YELLOW}?{C.RESET}  Completed download exists: {C.CYAN}{folder_name}{C.RESET}. "
                f"Overwrite? [{C.DIM}y/N{C.RESET}] "
            ).strip().lower()
            if answer != "y":
                log_info("Skipped")
                return True
        else:
            # Incomplete download — default to overwrite
            answer = input(
                f"  {C.YELLOW}?{C.RESET}  Incomplete download found: {C.CYAN}{folder_name}{C.RESET}. "
                f"Overwrite? [{C.DIM}Y/n{C.RESET}] "
            ).strip().lower()
            if answer == "n":
                log_info("Skipped")
                return True

        # Remove folder to start fresh
        log_info(f"Removing {C.CYAN}{folder_name}{C.RESET} for fresh download")
        shutil.rmtree(video_dir)

    log_header(f"{channel_name}  ·  {pub_date}  ·  {pub_time or ''}  ·  {title}")

    for d in (video_dir, metadata_dir, video_meta, subs_dir, channel_dir):
        d.mkdir(parents=True, exist_ok=True)

    # ── 3. Save video metadata JSON ──────────────────────────────────────────
    log_step("Saving video metadata")
    (video_meta / "metadata.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False)
    )
    log_ok(f"Saved {C.CYAN}metadata/video/metadata.json{C.RESET}")

    # ── 4. Download video (MKV, best quality ≤ 1080p) ────────────────────────
    log_step("Downloading video (MKV, ≤ 1080p)")
    video_file = video_dir / f"{folder_name}.mkv"
    run_ytdlp(binary, [
        "-f", "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
        "--merge-output-format", "mkv",
        "--no-overwrites",
        "-o", str(video_file),
        url,
    ])
    if video_file.exists():
        size_mb = video_file.stat().st_size / (1024 * 1024)
        log_ok(f"Video saved ({size_mb:.1f} MB)")
    else:
        log_error("Video file not found after download")

    # ── 5. Download manual subtitles (no auto-generated) ─────────────────────
    log_step("Downloading subtitles (manual only)")
    run_ytdlp(binary, [
        "--write-subs",
        "--no-write-auto-subs",
        "--all-subs",
        "--skip-download",
        "-o", str(subs_dir / "subtitle"),
        url,
    ])
    sub_files = list(subs_dir.iterdir())
    if sub_files:
        log_ok(f"Downloaded {len(sub_files)} subtitle file(s): "
               + ", ".join(f.name for f in sub_files))
    else:
        log_warn("No manual subtitles available")

    # ── 6. Download video thumbnail ──────────────────────────────────────────
    log_step("Downloading video thumbnail")
    thumb_url = meta.get("thumbnail")
    if thumb_url:
        download_image(thumb_url, video_meta / "thumbnail.jpeg")
    else:
        log_warn("No thumbnail URL in metadata")

    # ── 7. Channel info (metadata, avatar, banner) ───────────────────────────
    channel_url = meta.get("channel_url") or meta.get("uploader_url")
    if not channel_url:
        log_warn("No channel URL in video metadata — skipping channel assets")
    else:
        ch_meta = fetch_channel_metadata(binary, channel_url, channel_cache)
        if ch_meta:
            log_step("Saving channel metadata")
            (channel_dir / "metadata.json").write_text(
                json.dumps(ch_meta, indent=2, ensure_ascii=False)
            )
            log_ok(f"Saved {C.CYAN}metadata/channel/metadata.json{C.RESET}")

            thumbnails = ch_meta.get("thumbnails") or []

            log_step("Downloading channel images")
            avatar_url = pick_thumbnail(thumbnails, "avatar")
            if avatar_url:
                download_image(avatar_url, channel_dir / "avatar.jpeg")
            else:
                log_warn("Channel avatar not found in metadata")

            banner_url = pick_thumbnail(thumbnails, "banner")
            if banner_url:
                download_image(banner_url, channel_dir / "banner.jpeg")
            else:
                log_warn("Channel banner not found in metadata")
        else:
            log_warn("Could not fetch channel metadata")

    # ── Mark download as complete ─────────────────────────────────────────────
    log_step("Download complete")
    complete_marker.touch()
    log_ok(f"Marked as complete by creating file {C.CYAN}COMPLETE{C.RESET} ")
    log_ok(f"{C.BOLD}Done:{C.RESET} {folder_name}\n")
    return True


# ── CLI ───────────────────────────────────────────────────────────────────────

def cmd_download(args):
    """Execute the 'download' subcommand."""
    binary = get_ytdlp_binary()
    ensure_list_file()
    DOWNLOADS_DIR.mkdir(exist_ok=True)

    urls = read_urls()
    if not urls:
        log_warn(
            f"No URLs found in {C.CYAN}{LIST_FILE.name}{C.RESET}. "
            "Add video URLs and run again."
        )
        sys.exit(0)

    log_info(f"Found {C.BOLD}{len(urls)}{C.RESET} URL(s) in {C.CYAN}{LIST_FILE.name}{C.RESET}")

    channel_cache: dict = {}
    ok = 0
    fail = 0

    for i, (lineno, url) in enumerate(urls, 1):
        log_info(f"[{i}/{len(urls)}] Line {lineno}: {C.CYAN}{url}{C.RESET}")
        try:
            if process_video(binary, url, channel_cache):
                ok += 1
            else:
                fail += 1
        except KeyboardInterrupt:
            log_warn("\nInterrupted by user")
            sys.exit(130)
        except Exception as e:
            log_error(f"Unexpected error: {e}")
            fail += 1

    print()
    log_header("Summary")
    log_ok(f"Succeeded: {C.GREEN}{ok}{C.RESET}  |  Failed: {C.RED}{fail}{C.RESET}")


def print_help():
    """Print custom colored help message."""
    print(
        f"\n{C.BOLD}yt2pt {C.GREEN}{VERSION}{C.RESET} — Download YouTube videos with full metadata, subtitles, "
        f"and channel info. Ready to import in PeerTube.\n"
    )
    print(f"{C.BOLD}{C.YELLOW}Usage:{C.RESET}")
    print(f"  yt2pt <command> [options]\n")
    print(f"{C.BOLD}{C.YELLOW}Commands:{C.RESET}")
    print(f"  {C.GREEN}download{C.RESET}                     Download all videos listed in list.txt\n")
    print(f"{C.BOLD}{C.YELLOW}General Options:{C.RESET}")
    print(f"  {C.GREEN}-h{C.RESET}, {C.GREEN}--help{C.RESET}                   Show help.")
    print(f"  {C.GREEN}-v{C.RESET}, {C.GREEN}--version{C.RESET}                Show version and exit.\n")


def main():
    # Handle custom flags before argparse
    if len(sys.argv) == 1 or sys.argv[1] in ("-h", "--help"):
        print_help()
        sys.exit(0)
    if sys.argv[1] in ("-v", "--version"):
        print(f"yt2pt {VERSION}")
        sys.exit(0)

    parser = argparse.ArgumentParser(prog="yt2pt", add_help=False)
    subparsers = parser.add_subparsers(dest="command")

    dl = subparsers.add_parser("download", add_help=False)
    dl.add_argument("-h", "--help", action="store_true", default=False)

    args = parser.parse_args()

    if args.command is None:
        print_help()
        sys.exit(0)

    if args.command == "download":
        if args.help:
            print_help()
            sys.exit(0)
        cmd_download(args)


if __name__ == "__main__":
    main()
