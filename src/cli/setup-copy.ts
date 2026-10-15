// Browser copy stays separate from the terminal's verbose setup instructions.
import { callbackUrl } from "../connectors/square-oauth.js";
import { docUrl, type SetupGuide } from "./guide.js";
import type { SetupNote } from "./setup-server.js";

export function connectionNotes(guide: SetupGuide, port: number): SetupNote[] {
  const google = [
    { label: "Enable the Google Calendar API" },
    { label: "Download a service account JSON key" },
    { label: "Share your calendar with the service account", detail: 'Grant “Make changes to events” access, then copy the Calendar ID.' },
  ];
  const steps: Record<string, { label: string; detail?: string }[]> = {
    google,
    square: [
      { label: "Create a Square developer app" },
      { label: "Set its OAuth redirect URL", detail: `Use \`${callbackUrl(port)}\` in the same environment you select below.` },
      { label: "Copy the Application ID and secret" },
    ],
    glossgenius: [
      { label: "Copy your GlossGenius booking link", detail: "Online Booking → Share booking link." },
      { label: "Enable the Google Calendar API and download a JSON key" },
      google[2]!,
    ],
    slack: [
      { label: "Create a Slack app from the guide’s manifest", detail: "Includes Socket Mode, scopes and events." },
      { label: "Copy both app tokens", detail: "App-level: `xapp-…` (`connections:write`). Bot: `xoxb-…` after installation." },
      { label: "Invite the app to your channel", detail: "Use `/invite`, then copy the Channel ID (`C…`)." },
    ],
    whatsapp: [
      { label: "Create a Meta app with the WhatsApp product", detail: "WhatsApp → API Setup: add your own number under “To”, then copy the Phone number ID and the access token." },
      { label: "Copy the App Secret", detail: "App settings → Basic." },
      { label: "Have a public HTTPS URL for Mudroom", detail: "Meta calls it at `/webhooks/whatsapp`; the summary prints the URL and verify token to paste into WhatsApp → Configuration → Webhook." },
    ],
    twilio: [
      { label: "Copy your Account SID and Auth Token" },
      { label: "Choose an SMS-capable sender number" },
      { label: "Verify your mobile if you’re on a trial", detail: "Phone Numbers → Manage → Verified Caller IDs." },
    ],
  };
  const links = [{ label: "View setup guide", href: docUrl(guide.doc) }];
  if (guide.doc === "square") links.push({ label: "Square developer console", href: "https://developer.squareup.com/console/en/apps" });
  if (guide.doc === "slack") links.push({ label: "Slack apps", href: "https://api.slack.com/apps" });
  if (guide.doc === "twilio") links.push({ label: "Twilio console", href: "https://console.twilio.com" });
  if (guide.doc === "whatsapp") links.push({ label: "Meta for Developers", href: "https://developers.facebook.com/apps" });
  return [{ title: `Set up ${guide.label}`, items: steps[guide.doc] ?? guide.steps.map((label) => ({ label })), links }];
}
