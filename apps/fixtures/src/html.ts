/** HTML rendering. Every dynamic value goes through `esc`; pages load only /static/fixtures.css. */

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const DISCLOSURE =
  "AIRLOCK DEMO FIXTURE. This is a disclosed test service run by the Airlock project for its hackathon demo. " +
  "Data here is synthetic and form submissions are recorded only by this service; nothing is sent, shipped or contacted.";

export const STYLESHEET = `
:root { color-scheme: light dark; --fg: #1d2026; --bg: #fbfbf8; --muted: #5d6470; --line: #d6d8dc; --warn-bg: #fff4d6; --warn-fg: #6b4a00; --ok: #1f6f3f; --bad: #9b1c1c; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e9ec; --bg: #16181c; --muted: #a2a8b3; --line: #353a42; --warn-bg: #3a2f10; --warn-fg: #f3d58a; --ok: #7bd49a; --bad: #f19a9a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 44rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
.banner { background: var(--warn-bg); color: var(--warn-fg); border: 1px solid currentColor; border-radius: 6px; padding: .6rem .8rem; font-size: .9rem; }
h1 { font-size: 1.6rem; margin: 1.2rem 0 .4rem; }
h2 { font-size: 1.15rem; margin: 1.6rem 0 .4rem; }
p, li { color: var(--fg); }
.muted { color: var(--muted); font-size: .9rem; }
table { border-collapse: collapse; margin: .6rem 0; }
th, td { border: 1px solid var(--line); padding: .3rem .7rem; text-align: left; font-variant-numeric: tabular-nums; }
pre { border: 1px solid var(--line); border-radius: 6px; padding: .7rem; overflow-x: auto; }
label { display: block; font-weight: 600; margin-top: 1rem; }
input[type=text], textarea { width: 100%; font: inherit; padding: .45rem .55rem; border: 1px solid var(--line); border-radius: 4px; background: transparent; color: inherit; }
textarea { min-height: 6rem; }
button { margin-top: 1.2rem; font: inherit; padding: .5rem 1.1rem; border-radius: 4px; border: 1px solid var(--fg); background: var(--fg); color: var(--bg); cursor: pointer; }
.ok { color: var(--ok); }
.bad { color: var(--bad); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem 1rem; }
dt { font-weight: 600; }
dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
code { overflow-wrap: anywhere; }
`;

/** A complete page. `title` and `bodyHtml` are trusted only if built from escaped parts. */
export function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} (Airlock demo fixture)</title>
<link rel="stylesheet" href="/static/fixtures.css">
</head>
<body>
<main>
<p class="banner" role="note">${esc(DISCLOSURE)}</p>
${bodyHtml}
</main>
</body>
</html>
`;
}
