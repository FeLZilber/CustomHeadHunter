/** robots.txt parsing with RFC 9309 matching, plus the non-standard Crawl-delay. */
export interface RobotsRules {
  allows(pathAndQuery: string): boolean;
  /** Seconds the site asks crawlers to wait between requests, if it says so. */
  crawlDelaySeconds: number | null;
}

interface Rule {
  allow: boolean;
  pattern: string;
  matcher: RegExp;
}

const isRobotsFile = (path: string): boolean => path === "/robots.txt" || path.startsWith("/robots.txt?");

export const ALLOW_ALL: RobotsRules = { allows: () => true, crawlDelaySeconds: null };
/** What RFC 9309 prescribes when robots.txt cannot be fetched: assume nothing may be crawled. */
export const DISALLOW_ALL: RobotsRules = { allows: (path) => isRobotsFile(path), crawlDelaySeconds: null };

/** Turns a robots path pattern into a start-anchored regex; `*` is any run, a trailing `$` anchors the end. */
function compilePattern(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`);
}

interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelay: number | null;
}

function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let collectingAgents = false;
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      // Consecutive user-agent lines share one group; a rule line closes the agent list.
      if (!current || !collectingAgents) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
      continue;
    }
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      collectingAgents = false;
      // An empty value matches nothing, so "Disallow:" permits everything.
      if (value) current.rules.push({ allow: field === "allow", pattern: value, matcher: compilePattern(value) });
    } else if (field === "crawl-delay") {
      collectingAgents = false;
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = Math.max(current.crawlDelay ?? 0, seconds);
    }
  }
  return groups;
}

export function parseRobots(text: string, productToken: string): RobotsRules {
  const groups = parseGroups(text);
  const token = productToken.toLowerCase();
  const named = groups.filter((g) => g.agents.includes(token));
  const selected = named.length > 0 ? named : groups.filter((g) => g.agents.includes("*"));
  if (selected.length === 0) return ALLOW_ALL;

  const rules = selected.flatMap((g) => g.rules);
  const delays = selected.map((g) => g.crawlDelay).filter((d): d is number => d !== null);
  return {
    crawlDelaySeconds: delays.length > 0 ? Math.max(...delays) : null,
    allows(pathAndQuery) {
      if (isRobotsFile(pathAndQuery)) return true;
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!rule.matcher.test(pathAndQuery)) continue;
        // Longest pattern wins; on equal length Allow beats Disallow.
        if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
          best = rule;
        }
      }
      return best ? best.allow : true;
    },
  };
}
