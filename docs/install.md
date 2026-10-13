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

A first run opens with a few lines on what Gateway does and what the wizard writes, then asks for your website so it can prefill the questions that follow (optional: press Enter to skip, see [Starting from your website](#starting-from-your-website)). Next it asks what you want agents to do (*Book appointments*, or *Book appointments and message me*, which adds the Slack or SMS owner channel) and which booking system you use. For a system that is not set up yet it lists what you need, with a link to that connector's guide, and asks whether you are ready to connect; you can open the guide in your browser from there. The owner channel (Slack or Twilio SMS) gets the same step. After that it asks for your business name (or your own name: it works for anyone who takes bookings against a Google Calendar, a shop, a consultant or a founder taking intro calls) and time zone. With Google Calendar it also asks for services, opening hours and your service account key; with Square Appointments it runs Square's OAuth flow in your browser and takes services and hours from Square. Choices such as the goal and the booking system are an arrow-key list: up and down to move, Enter to pick, Esc to keep the default; with output piped or `TERM=dumb` it becomes a numbered list and you type the number. It then writes `config.json` and `.env` (mode 600), checks access and prints the next steps: tunnel, `ALLOWED_HOSTS`, `npm start` and a local check, then the agent connector.

You can skip the booking system for now: answer *Not yet, finish later* to "Ready to connect?", or run `npm run init -- --no-backend`. The wizard says that nothing is connected for now, then asks only for your name, time zone and currency (plus services and hours when it read some from your website, so that reading is not lost) and ends with the setup steps for the system you picked. The files are written, but the gateway will not start until the `GOOGLE_*` or `SQUARE_*` variables are set ([connectors/](connectors/README.md)).

Run the wizard again any time with `npm run init`: it finds the saved files and asks first: *Keep it as it is* (change nothing), *Review and update* (your saved answers are the defaults and your `config.json` and `.env` edits are kept) or *Start over* (the saved answers are ignored and both files are replaced when the wizard finishes). `npm run init -- --help` lists the flags for a non-interactive run; `--force` starts over.

### Starting from your website

On a first run (and after *Start over*) the wizard's first question is `Your website (Enter to skip)`. Give it an address such as `example.com` and it works in two steps:

1. **It reads the site.** Up to 8 public pages: the start page, then the pages whose links look like services, prices, booking, hours, contact or about. It reads them once, as plain HTML, without running scripts, so a site drawn entirely by JavaScript gives it little. Only public web addresses are read; `localhost` and private network addresses are refused. From the HTML alone it recognises the booking system the site links to: Square Appointments and GlossGenius are then pre-selected in the booking system list, and for any other system it says that Gateway cannot connect to it yet.
2. **It asks which model should read the text.** Before anything is sent it says so and lists what it found on this machine. There are three ways to supply a model:
   - a command-line tool you are already signed in to: Claude Code (`claude`) or Codex (`codex`). Claude Code runs with every tool turned off; Codex runs in its read-only sandbox with its shell, apps and web search turned off. Both run in an empty temporary folder, without Gateway's own credentials in their environment;
   - an API key in the environment: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `DEEPSEEK_API_KEY`;
   - *Paste an API key*: an Anthropic, OpenAI or DeepSeek key typed into a hidden prompt (it shows dots). The key is used for that one request and is not written to `.env`, `config.json` or any log.

   The text of those public pages is sent to the provider you pick, as one request on your own account or key. Pick *Skip*, or press Esc, and nothing is sent.

Gateway saves nothing from this step: not the page text, not the model's answer, not a pasted key (what the provider keeps is up to its own terms). What comes back only becomes the default answer to the questions that follow (name, time zone, currency, opening hours and services), and each one is still yours to change or clear. The wizard does not take the model's word for it either: a name must appear on your pages, and a price is read from the page line itself.

With Google Calendar, a service whose line on your site shows its name, one fixed price and at most a duration is offered as a bookable service (with 60 minutes as the duration when the site gives none). The wizard errs on the side of caution here: a line with any other word or symbol beside the price is not read as a fixed price. The one exception is a country written before a dollar sign, such as `US$40` or `S$20`, which is read as the price when it names the currency found on your site, and is moved to the ask-the-owner list if you then choose a different currency. The others, such as "from $80" or "call for a quote", are all listed and then offered together as [ask-the-owner services](agents.md#ask-the-owner-services): agents can read them and message you about them but cannot book them. When the site gave no fixed-price service, that list is shown first and the question for services you type in yourself comes after it. With Square or GlossGenius your services come from that platform, so the ones found on your site are not added.

Gateway books appointments, so what the model marks as a product for sale (a handbag, a gift card) is left out of both lists. The summary under *Found on your site* counts what was left out and names the first few, and says so when the site looks like an online shop. If one of them is a service after all, type it in at the service question.

To skip the step, press Enter at the question. `npm run init -- --website example.com` answers it up front. It is not asked on a *Review and update* run, and `--non-interactive` never reads a website.

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
