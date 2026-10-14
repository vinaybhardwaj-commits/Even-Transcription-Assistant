# eta-lab fork of herdr-radar

Upstream: github.com/hhdebb/herdr-radar v1.3.12, commit aff4838 (reviewed by Fable, 24 Sep 2026).
Vendored without `.git`, `.github` and the README images in `assets/` (`assets/marks` kept: `tools/check.js` reads it).
Every change below is marked `eta-lab fork` in the source. Upstream files not listed here are untouched.

## Changes

1. `lib/config.js`: new keys in the plugin's `config.toml` (`$HERDR_PLUGIN_CONFIG_DIR/config.toml`).
   - `poll_ms` (default 150): scheduler poll and animation frame. Between 50 and 60000; anything else (0, negative, NaN, a quoted string, above 60000) gives the default.
   - `frame_floor_ms` (default 120): shortest gap between two frames. Never above `poll_ms`.
   - `spinner`: `braille` (default), `line`, `dots`, `still`. `spinner_frames = "abc"` overrides it, one frame per character.
   - `headless` (default false): see change 4.
   Defaults reproduce upstream behaviour exactly.
2. `lib/daemon.js`, `lib/frame.js`: read `POLL_MS`, `FRAME_FLOOR_MS` and `SPIN_MS` from `lib/config.js`. Were constants.
3. `herdr-plugin.toml`, `bin/run-node.sh`: every `node` command now runs through `sh bin/run-node.sh`. A remote herdr server has no `~/.local/bin` on its PATH; the wrapper finds node in PATH, then `~/.local/node/bin`, `/opt/homebrew/bin`, `/usr/local/bin`.
4. `headless = true` (for a server that hosts panes and has no client): the daemon still publishes pane tokens, but
   - `lib/setup.js`: never writes `config.toml`, never installs the font;
   - `lib/daemon.js`: no managed-block variant rewrite, no tab-bar line, no theme sync (`followAppearance` forced off in `lib/config.js`).
   Set `variant` explicitly with it (`auto` asks whether this host has the icon font; a server has none).

5. `tools/check.js`: one added check, `cadenceFallsBack`, runs the real config parser on ten `poll_ms` / `frame_floor_ms` inputs, including 0, NaN, a quoted string, 2147483648 and 60001.

## Not changed

- Token names, sort keys, the agent-view override and every socket call. No `agent rename`, `pane rename` or close anywhere in the plugin.
- `bin/settings.js` does not list the new keys. Edit `config.toml` by hand.

## Rollout order (every host)

The daemon reads only `$HERDR_PLUGIN_CONFIG_DIR/config.toml`. Files in `config/` are templates to copy there.

- Remote agent host: copy `config/headless-remote.toml` into the plugin config dir BEFORE `plugin link`. `[[build]]` runs `bin/setup.js` at link time; without `headless = true` it writes the host's herdr `config.toml` and installs the font.
- The Mini: a missing `config.toml` gives 150 ms, and so does a quoted `"1000"`.
- After each link, read the effective values back from the plugin dir:
  `HERDR_PLUGIN_CONFIG_DIR=<dir> node -e 'const c=require("./lib/config");console.log(c.POLL_MS,c.FRAME_FLOOR_MS,c.headless)'`
- The `configure` and `install-font` actions are not headless-guarded. Never run them on a remote host.

## Config templates

`config/headless-remote.toml`: for a remote agent host. `config/mini.toml`: for the Mini (1000 ms).
