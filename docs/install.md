# Installing gateway

Needs Node >= 22.13 (uses the built-in `node:sqlite`), git and npm. No sudo. The script runs on macOS and Linux; on Windows use WSL or follow [Manual install](#manual-install).

## Installer

```bash
curl -fsSL https://raw.githubusercontent.com/mudroom-ai/gateway/main/install.sh | sh
```

Or read it first:

```bash
curl -fsSL -o install.sh https://raw.githubusercontent.com/mudroom-ai/gateway/main/install.sh
less install.sh
sh install.sh
```

The script clones into `~/gateway` (override with `GATEWAY_DIR`), builds, and runs the setup wizard. Running it again moves the checkout to the latest release; the wizard then finds your `config.json` and asks whether to keep it as it is, review and update it, or start over.

The one-liner installs the latest tagged release (the highest `vX.Y.Z` tag), or `main` if there are no tags yet. It prints the ref it chose. Set `GATEWAY_REF` to install something else: a tag, a branch or a commit sha.

```bash
curl -fsSL https://raw.githubusercontent.com/mudroom-ai/gateway/main/install.sh | GATEWAY_REF=main sh
```

## The setup wizard

A first run opens with a few lines on what Gateway does and what the wizard writes, then asks what you want agents to do (*Book appointments*, or *Book appointments and message me*, which adds the Slack or SMS owner channel) and which booking system you use. For a system that is not set up yet it lists what you need, with a link to that connector's guide, and asks whether you are ready to connect; you can open the guide in your browser from there. The owner channel (Slack or Twilio SMS) gets the same step. After that it asks for your business name (or your own name: it works for anyone who takes bookings against a Google Calendar, a shop, a consultant or a founder taking intro calls) and time zone. With Google Calendar it also asks for services, opening hours and your service account key; with Square Appointments it runs Square's OAuth flow in your browser and takes services and hours from Square. Choices such as the goal and the booking system are an arrow-key list: up and down to move, Enter to pick, Esc to keep the default; with output piped or `TERM=dumb` it becomes a numbered list and you type the number. It then writes `config.json` and `.env` (mode 600), checks access and prints the next steps: tunnel, `ALLOWED_HOSTS`, `npm start` and a local check, then the agent connector.

You can skip the booking system for now: answer *Not yet, finish later* to "Ready to connect?", or run `npm run init -- --no-backend`. The wizard then asks only for your name, time zone and currency and ends with the setup steps for the system you picked. The files are written, but the gateway will not start until the `GOOGLE_*` or `SQUARE_*` variables are set ([connectors/](connectors/README.md)).

Run the wizard again any time with `npm run init`: it finds the saved files and asks first: *Keep it as it is* (change nothing), *Review and update* (your saved answers are the defaults and your `config.json` and `.env` edits are kept) or *Start over* (the saved answers are ignored and both files are replaced when the wizard finishes). `npm run init -- --help` lists the flags for a non-interactive run; `--force` starts over.

## Manual install

```bash
git clone https://github.com/mudroom-ai/gateway && cd gateway
npm ci && npm run build
npm run init                         # or: cp config.example.json config.json and edit it
npm start                            # http://127.0.0.1:3000, loads .env if present
```

Scripts: `build`, `typecheck`, `test`, `dev` (runs from source), `init` (setup wizard), `start` (runs `dist/` after `build` and loads `.env` via `node --env-file-if-exists`). Tests run against an in-memory calendar in `test/helpers/`.

## Checking it works

```bash
curl -s localhost:3000/api/services
```

lists the services with their ids. Then ask for slots with `POST /api/slots` (see the README, or the full [smoke test](agents.md#smoke-test-over-http)).

## Updating

Run the installer again: it fetches tags and checks out the newest release (or `GATEWAY_REF`), then rebuilds. By hand: `git fetch --tags && git checkout <tag> && npm ci && npm run build` in the checkout (on a branch, `git pull --ff-only` instead of the checkout). `config.json`, `.env` and `gateway.sqlite` are gitignored and stay where they are. Docker and platform hosting: [deploy.md](deploy.md).
