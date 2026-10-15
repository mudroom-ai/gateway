# Mudroom docs

- [install.md](install.md): installer, setup wizard, manual install, updating
- [configuration.md](configuration.md): `config.json` fields and every environment variable
- [connectors/README.md](connectors/README.md): the three modules (Store, Calendar, Communication), the registry ([Google Calendar](connectors/google.md), [Square Appointments](connectors/square.md)), and the definition of done for adding one
- [connectors/glossgenius.md](connectors/glossgenius.md): GlossGenius Store connector in shadow mode (experimental): reads the public booking page, writes to a shared Google Calendar
- [connectors/twilio.md](connectors/twilio.md): Twilio SMS Communication connector, outbound notices only, works beside any Store or Calendar connector
- [connectors/slack.md](connectors/slack.md): Slack Communication connector with two-way threads, works beside any Store or Calendar connector; Socket Mode, no inbound URL
- [deploy.md](deploy.md): Docker, HTTPS tunnel, platform hosting, operations, unsafe calendar sources
- [agents.md](agents.md): what agents see (`llms.txt`, `openapi.json`, the HTTP API), booking semantics, HTTP smoke test
- [errors.md](errors.md): the one error shape and every code
- [architecture.md](architecture.md): process shape, connector contracts, HTTP-only note
