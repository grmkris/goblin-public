/**
 * `/robots.txt` for a stage (src/worker.ts): production lets crawlers read its public pages (the landing, the
 * policies) and never the API; every other stage (dev holds test data only) asks them to stay out entirely.
 */
export function robotsTxt(stage: string | undefined): string {
  return stage === 'prod'
    ? 'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /mcp\n'
    : 'User-agent: *\nDisallow: /\n'
}
