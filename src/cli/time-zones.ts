import { rawTimeZones } from "@vvo/tzdb";
import type { Prompter } from "./init.js";

export type TimeZoneSource = "device" | "saved" | "website" | "provided" | "selected";
export interface TimeZoneOption {
  id: string;
  label: string;
  country: string;
  cities: string[];
  aliases: string[];
  search: string;
}
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[_/]/g, " ").toLowerCase().trim();
export function isTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; }
}
const countryAliases: Record<string, string> = { US: "USA United States of America", GB: "UK Britain Great Britain" };
const utc: TimeZoneOption = { id: "UTC", label: "Coordinated Universal Time · UTC", country: "Worldwide", cities: [], aliases: ["UTC", "Etc/UTC", "GMT"], search: "utc gmt coordinated universal time worldwide" };
export const timeZones: TimeZoneOption[] = [utc, ...rawTimeZones.filter((zone) => isTimeZone(zone.name)).map((zone) => ({
  id: zone.name,
  label: `${zone.alternativeName} · ${zone.mainCities[0] || zone.name.split("/").at(-1)!.replaceAll("_", " ")}`,
  country: zone.countryName,
  cities: zone.mainCities,
  aliases: zone.group,
  search: normalize([zone.name, zone.alternativeName, zone.countryName, zone.countryCode, countryAliases[zone.countryCode], zone.abbreviation, zone.dstAbbreviation, ...zone.mainCities, ...zone.group].filter(Boolean).join(" ")),
}))].sort((a, b) => a.label.localeCompare(b.label));

export function zoneOption(id: string): TimeZoneOption {
  const found = timeZones.find((zone) => zone.id === id || zone.aliases.includes(id));
  if (found) return { ...found, id }; // Keep an existing alias unchanged in the saved files.
  if (!isTimeZone(id)) throw new Error(`Unknown time zone: ${id}`);
  const name = new Intl.DateTimeFormat("en", { timeZone: id, timeZoneName: "longGeneric" }).formatToParts().find((part) => part.type === "timeZoneName")?.value || id;
  const city = id.split("/").at(-1)!.replaceAll("_", " ");
  return { id, label: name === city ? city : `${name} · ${city}`, country: "", cities: [city], aliases: [id], search: normalize(`${id} ${name} ${city}`) };
}
export function searchTimeZones(query: string): TimeZoneOption[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  return timeZones.filter((zone) => terms.every((term) => zone.search.includes(term)));
}
export function timeZoneClock(id: string, date = new Date()): string {
  return new Intl.DateTimeFormat("en", { timeZone: id, hour: "numeric", minute: "2-digit", timeZoneName: "shortOffset" }).format(date);
}
export const timeZoneSourceLabel = (source: TimeZoneSource) => ({
  device: "Detected from this machine", saved: "Saved selection", website: "Suggested by your website", provided: "Provided in setup options", selected: "Your selection",
})[source];

/** Same confirm → search → select flow as the browser; no IANA syntax required. */
export async function selectTerminalTimeZone(p: Pick<Prompter, "ask" | "choose">, suggested: string, source: TimeZoneSource): Promise<string> {
  const selected = zoneOption(suggested);
  for (;;) {
    const use = await p.choose("Your business time zone", [{ label: selected.label, status: selected.country }, { label: "Change time zone" }], 0,
      [timeZoneSourceLabel(source), `Local time: ${timeZoneClock(selected.id)}`]);
    if (use === 0) return selected.id;
    for (;;) {
      const query = await p.ask("Search city or time zone (Enter to go back)");
      if (!query) break;
      const matches = searchTimeZones(query);
      if (!matches.length) {
        const action = await p.choose("No time zones found", [{ label: "Search again" }, { label: "Back" }], 0, ["Try a nearby major city, country, or time-zone name."], 1);
        if (action === 1) break;
        continue;
      }
      const visible = matches.slice(0, 8);
      const items = [...visible.map((zone) => ({ label: `${zone.label} · ${zone.country}`, status: timeZoneClock(zone.id) })), { label: "Search again" }, { label: "Back" }];
      const index = await p.choose("Choose your business time zone", items, 0, matches.length > visible.length ? ["Type a more specific search to see other results."] : undefined, items.length - 1);
      if (index === items.length - 1) break;
      if (index === visible.length) continue;
      selected.id = visible[index]!.id;
      selected.label = visible[index]!.label;
      selected.country = visible[index]!.country;
      source = "selected";
      break;
    }
  }
}
