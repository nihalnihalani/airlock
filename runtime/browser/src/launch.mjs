// Fixed Chromium launch flags for the runner (and for the in-image test harness, which omits the
// proxy flags). Imports nothing, so it is unit-testable without a browser.
//
// --disable-features: Chromium keeps only the LAST `--disable-features` switch, and Playwright
// passes its own list first. A second list therefore REPLACES Playwright's (verified: with only
// `--disable-features=DnsOverHttps,AsyncDns`, Playwright's ThirdPartyStoragePartitioning opt-out was
// lost). So the runner passes one list that is a superset of Playwright's, and after launch checks
// the browser process's argv (`featureFlagFailures`): the effective list must contain every feature
// of every earlier list plus Airlock's own; otherwise the runner exits.

/** playwright-core 1.63.0 `chromiumSwitches.ts` disabledFeatures (bump together with the pin). */
export const PLAYWRIGHT_DISABLED_FEATURES = Object.freeze([
  "AvoidUnnecessaryBeforeUnloadCheckSync", "DestroyProfileOnBrowserClose", "DialMediaRouteProvider",
  "GlobalMediaControls", "HttpsUpgrades", "LensOverlay", "MediaRouter", "PaintHolding",
  "ThirdPartyStoragePartitioning", "BlockOriginHeaderModificationOnRedirect", "Translate",
  "AutoDeElevate", "OptimizationHints", "msForceBrowserSignIn", "msEdgeUpdateLaunchServicesPreferredVersion",
]);

/**
 * Airlock's own: no DNS outside the proxy; no Reporting API / Network Error Logging uploads (sent by
 * the network service, outside the renderer; defence in depth next to the request route).
 */
export const AIRLOCK_DISABLED_FEATURES = Object.freeze(["DnsOverHttps", "AsyncDns", "Reporting", "NetworkErrorLogging"]);

export const DISABLED_FEATURES = Object.freeze([...new Set([...PLAYWRIGHT_DISABLED_FEATURES, ...AIRLOCK_DISABLED_FEATURES])]);

/** Launch args; `proxy` null only in the in-image harness (no proxy, loopback server). */
export function chromiumLaunchArgs(proxy) {
  return [
    ...(proxy
      ? [
          `--proxy-server=${proxy}`,
          // Chromium bypasses the proxy for loopback implicitly; `<-loopback>` removes that bypass.
          "--proxy-bypass-list=<-loopback>",
        ]
      : []),
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--disable-background-networking",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    `--disable-features=${DISABLED_FEATURES.join(",")}`,
  ];
}

/** Why the browser process's argv does not carry the required feature opt-outs ([] = fine). */
export function featureFlagFailures(argv, required = AIRLOCK_DISABLED_FEATURES) {
  const lists = argv.filter((a) => a.startsWith("--disable-features=")).map((a) => a.slice("--disable-features=".length).split(",").filter(Boolean));
  if (lists.length === 0) return ["noDisableFeatures"];
  const effective = new Set(lists.at(-1));
  const failures = [];
  for (const feature of required) if (!effective.has(feature)) failures.push(`missing:${feature}`);
  for (const list of lists.slice(0, -1)) for (const feature of list) if (!effective.has(feature)) failures.push(`overridden:${feature}`);
  return failures;
}
