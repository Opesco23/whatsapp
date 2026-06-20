import os
import time
import requests
import re
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from dotenv import load_dotenv
load_dotenv()

# --- API Constants ---
BASE_URL = "https://quizmd.online/api"
LOGIN_URL = f"{BASE_URL}/web/login"
STATE_URL = f"{BASE_URL}/wordle/state"
START_URL = f"{BASE_URL}/wordle/start"
GUESS_URL = f"{BASE_URL}/wordle/guess"

WORDKEG_SEARCH_URL = "https://www.wordkeg.com/wordle-solver/search.php"
HANDLE = os.getenv("HANDLE")
CODE = os.getenv("CODE")

class WordleBot:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": "https://quizmd.online",
            "Referer": "https://quizmd.online/wordle"
        })

        self.wordkeg_session = requests.Session()
        retries = Retry(total=3, backoff_factor=1, status_forcelist=[500, 502, 503, 504])
        self.wordkeg_session.mount("https://", HTTPAdapter(max_retries=retries))
        self.wordkeg_session.headers.update({
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"
        })

        self.global_rejected_words = set()

        self.last_winning_word = "MIAOU"

    def login(self):
        """Authenticates the session to access the Wordle API."""
        print(f"[*] Logging in as {HANDLE}...")
        payload = {"handle": HANDLE, "code": CODE}
        response = self.session.post(LOGIN_URL, json=payload, timeout=10)

        if response.status_code == 200 and response.json().get("ok"):
            print("[+] Login successful.")
        else:
            raise Exception(f"Login failed: {response.text}")

    def start_new_game(self):
        """Starts a fresh game of Wordle."""
        response = self.session.post(START_URL, json={}, timeout=10)
        response.raise_for_status()
        return response.json().get("state", {})

    def get_game_state(self):
        """Retrieves the current game state."""
        response = self.session.get(STATE_URL, timeout=10)
        response.raise_for_status()
        return response.json().get("state", {})

    def submit_guess(self, word):
        """Submits a 5-letter word guess to the game API."""
        print(f"[*] Submitting guess: {word}")
        payload = {"guess": word}
        response = self.session.post(GUESS_URL, json=payload, timeout=10)

        if response.status_code == 400:
            print(f"[-] Invalid word rejected by API: {word}")
            return None

        response.raise_for_status()
        return response.json().get("state", {})

    def get_wordkeg_suggestion(self, state):
        """Builds constraint parameters from the current game state and queries Wordkeg for suggestions."""
        includes = set()
        excludes = set()
        positioned = ["_"] * 5
        bad_positioned_list = []

        guesses = state.get("guesses", [])

        # Use the last winning word (or MIAOU) if we are starting a fresh game
        if not guesses:
            if self.last_winning_word not in self.global_rejected_words:
                return self.last_winning_word
            else:
                return "MIAOU"

        # Parse the pattern array from QuizMD to build solver constraints
        for guess in guesses:
            word = guess["word"]
            pattern = guess["pattern"]

            bad_row = ["_"] * 5
            has_new_bad = False

            for i, (letter, status) in enumerate(zip(word, pattern)):
                letter = letter.lower()
                if status == "correct":
                    positioned[i] = letter
                    includes.add(letter)
                elif status == "present":
                    bad_row[i] = letter
                    has_new_bad = True
                    includes.add(letter)
                elif status == "absent":
                    if letter not in includes:
                        excludes.add(letter)

            if has_new_bad:
                bad_positioned_list.append(bad_row)

        params = {
            "includesInput": "".join(includes),
            "excludesInput": "".join(excludes),
            "positioned": "".join(positioned),
            "limit": "50", # Fetch more so we have fallbacks if words are rejected
            "dictionary": "wordle"
        }

        # Wordkeg supports multiple rows of misplaced letters
        for i, bp in enumerate(bad_positioned_list[:3]):
            key = "badPositioned" if i == 0 else f"badPositioned{i}"
            params[key] = "".join(bp)

        # Fetch data from Wordkeg using robust retry logic
        resp = None
        for attempt in range(3):
            try:
                resp = self.wordkeg_session.get(WORDKEG_SEARCH_URL, params=params, timeout=10)
                resp.raise_for_status()
                break
            except requests.exceptions.RequestException as e:
                print(f"[-] Network error connecting to Wordkeg (Attempt {attempt + 1}/3): {e}")
                time.sleep(2)

        if not resp:
            print("[-] Failed to fetch suggestions from Wordkeg after multiple attempts.")
            return None

        # Parse the HTML response to extract Wordkeg's suggested links
        matches = re.findall(r'/word/([a-z]+)', resp.text, re.IGNORECASE)
        suggestions = list(dict.fromkeys(matches))

        # Return the first valid suggestion that isn't in our global blocklist
        for suggestion in suggestions:
            word = suggestion.upper()
            if word not in self.global_rejected_words:
                return word

        return None

    def play_single_game(self):
        """Plays one complete game of Wordle."""
        state = self.get_game_state()

        # Start a new game if the current one is already completed upon load
        if state.get("completed", False):
            state = self.start_new_game()

        previous_remaining = state.get("remaining", 6)
        stuck_counter = 0

        while state.get("active") and state.get("remaining", 0) > 0:
            current_remaining = state.get("remaining")
            print(f"[*] Guesses remaining: {current_remaining}")

            # Anti-loop check: If guesses remaining isn't moving, the game is stuck in a loop
            if current_remaining == previous_remaining:
                stuck_counter += 1
            else:
                stuck_counter = 0
                previous_remaining = current_remaining

            if stuck_counter >= 15:
                print("[-] Detected infinite loop. Forcing game reset.")
                self.start_new_game()
                return False

            # Ask WordKeg for the next best move
            next_word = self.get_wordkeg_suggestion(state)

            if not next_word:
                print("[-] Wordkeg couldn't find a valid suggestion.")
                self.start_new_game() # Force reset because the solver hit a dead end
                return False

            if len(next_word) != 5:
                print(f"[-] Wordkeg returned invalid length word: {next_word}. Retrying...")
                self.global_rejected_words.add(next_word)
                time.sleep(1)
                continue

            # Submit the word to QuizMD
            new_state = self.submit_guess(next_word)

            if new_state is None:
                # Invalid word trap
                print(f"[*] Word '{next_word}' was rejected by API. Marking as permanently rejected.")
                self.global_rejected_words.add(next_word)
                continue

            state = new_state
            time.sleep(1) # Polite delay to avoid rate-limiting

        # Check win/loss conditions
        if state.get("won"):
            winning_word = state.get("guesses", [])[-1]["word"]
            self.last_winning_word = winning_word
            print(f"\n[🏆] VICTORY! The bot successfully solved the Wordle. (Word: {winning_word})")
            return True
        else:
            print("\n[💀] DEFEAT! The bot ran out of guesses.")
            # Default back to MIAOU after a loss to reset the baseline
            self.last_winning_word = "MIAOU"
            # Force reset the game state on loss to prevent hanging states
            self.start_new_game()
            return False

    def play_continuously(self):
        """Main loop that runs games until Ctrl+C is pressed."""
        print("[*] Starting continuous play mode. Press Ctrl+C to stop.")
        games_played = 0
        games_won = 0

        try:
            self.login()

            while True:
                print(f"\n[=] --- Starting Game {games_played + 1} ---")

                # Play the game and record the result
                won = self.play_single_game()

                games_played += 1
                if won:
                    games_won += 1

                win_rate = (games_won / games_played) * 100
                print(f"[*] Session Stats: {games_won}/{games_played} wins ({win_rate:.1f}%)")

                print("[*] Waiting 3 seconds before next game...")
                time.sleep(3)

        except KeyboardInterrupt:
            print("\n\n[!] Ctrl+C detected. Stopping the bot gracefully.")
            if games_played > 0:
                win_rate = (games_won / games_played) * 100
                print(f"[=] Final Session Stats: {games_won}/{games_played} wins ({win_rate:.1f}%)")
            else:
                print("[=] No games were completed.")

        except Exception as e:
            print(f"\n[!] A fatal error occurred: {e}")

if __name__ == "__main__":
    bot = WordleBot()
    bot.play_continuously()
