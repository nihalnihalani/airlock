// Hostile Node sample. Under run.sh's permission model most escapes are denied outright; whatever
// still lands in outputs/ must be refused by the collector. Only outputs/ok.txt may be collected.
import { writeFileSync, symlinkSync, readFileSync } from "node:fs";

const tried = {};
const attempt = (name, fn) => { try { fn(); tried[name] = "ok"; } catch (e) { tried[name] = e.code ?? e.message; } };
writeFileSync("outputs/ok.txt", "the only acceptable output\n");
writeFileSync("outputs/chart.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n');
writeFileSync("outputs/page.html", "<script>alert(1)</script>\n");
writeFileSync("outputs/bad.json", "{not json");
attempt("symlink", () => symlinkSync("/etc/passwd", "outputs/passwd.csv"));
attempt("readPasswd", () => readFileSync("/etc/passwd"));
attempt("writeInputs", () => writeFileSync("inputs/regions.csv", "tampered"));
attempt("childProcess", () => process.binding("spawn_sync"));
console.log(JSON.stringify(tried));
