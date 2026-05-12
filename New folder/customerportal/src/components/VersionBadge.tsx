import { useEffect, useState } from "react";

/**
 * VersionBadge
 * ------------
 * A small fixed badge (bottom-left) that exposes THREE build-id reference
 * points so you can verify whether dev and prod are actually running the
 * same code:
 *
 *   1. Bundle      — the `__BUILD_ID__` baked into the running JS bundle
 *                    (set by the famous-build-id-injection Vite plugin).
 *                    This is the version of the React app the browser is
 *                    actually executing right now.
 *
 *   2. Active SW   — the build id reported by the service worker currently
 *                    controlling this page (via the GET_BUILD_ID message).
 *                    May be older than the bundle if a new SW is waiting.
 *
 *   3. Server SW   — the build id inside `/sw.js` AS SERVED BY THE ORIGIN
 *                    RIGHT NOW (fetched with cache: "no-store"). This is
 *                    the version the deploy host is currently shipping.
 *                    If this matches between dev and prod, both
 *                    environments are deploying the same SW.
 *
 * How to use this for debugging dev-vs-prod drift:
 *
 *   - Open dev and prod side-by-side.
 *   - Compare the three values in each badge.
 *   - Bundle differs   → React app JS is literally different code.
 *   - Server SW differs → one environment hasn't deployed the latest SW.
 *   - Active != Server  → user is stuck on a stale SW (click "Force Refresh").
 *
 * The "Force Refresh" button unregisters every service worker, deletes
 * every Cache Storage entry, and hard-reloads. Use this as the nuclear
 * option when a user reports stale UI that survives normal reloads.
 */
export function VersionBadge() {
  const bundleId =
    (globalThis as unknown as { __BUILD_ID__?: string }).__BUILD_ID__ ?? "dev";

  const [activeSwId, setActiveSwId] = useState<string>("…");
  const [serverSwId, setServerSwId] = useState<string>("…");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // --- Ask the active SW for its build id -----------------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) {
      setActiveSwId("no-sw");
      return;
    }

    let cancelled = false;

    const onMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === "BUILD_ID") {
        if (!cancelled) setActiveSwId(String(event.data.buildId ?? "?"));
      }
      if (event.data && event.data.type === "SW_ACTIVATED") {
        if (!cancelled) setActiveSwId(String(event.data.buildId ?? "?"));
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);

    const ask = () => {
      const ctrl = navigator.serviceWorker.controller;
      if (!ctrl) {
        setActiveSwId("none");
        return;
      }
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => {
        if (e.data && e.data.type === "BUILD_ID") {
          if (!cancelled) setActiveSwId(String(e.data.buildId ?? "?"));
        }
      };
      try {
        ctrl.postMessage({ type: "GET_BUILD_ID" }, [channel.port2]);
      } catch {
        // Older SW without MessageChannel support — fall back to broadcast.
        ctrl.postMessage({ type: "GET_BUILD_ID" });
      }
    };

    // Ask once now, and again once the SW is ready (covers first-load).
    ask();
    navigator.serviceWorker.ready.then(ask).catch(() => {});

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, []);

  // --- Fetch /sw.js directly to see what the SERVER is currently shipping
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/sw.js", { cache: "no-store" });
        const text = await res.text();
        const match = text.match(/CACHE_VERSION\s*=\s*['"]([^'"]+)['"]/);
        if (!cancelled) setServerSwId(match ? match[1] : "unknown");
      } catch {
        if (!cancelled) setServerSwId("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const bundleVsServer = bundleId === serverSwId;
  const activeVsServer = activeSwId === serverSwId;
  const allMatch = bundleVsServer && activeVsServer;

  const dotColor = allMatch
    ? "bg-emerald-500"
    : bundleVsServer
    ? "bg-amber-500"
    : "bg-rose-500";

  const handleForceRefresh = async () => {
    setBusy(true);
    try {
      // 1. Nuke every cache.
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      // 2. Unregister every service worker on this origin.
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch {
      /* ignore — still attempt reload */
    }
    // 3. Hard reload, bypassing the HTTP cache where possible.
    window.location.reload();
  };

  const handleCopy = () => {
    const payload = `bundle=${bundleId}\nactive-sw=${activeSwId}\nserver-sw=${serverSwId}\nurl=${window.location.href}\nua=${navigator.userAgent}`;
    navigator.clipboard?.writeText(payload).catch(() => {});
  };

  return (
    <div className="fixed bottom-2 left-2 z-[9998] font-mono text-[10px] leading-tight">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Show build version info"
          className="flex items-center gap-1.5 rounded-full border border-slate-300 bg-white/90 px-2 py-1 text-slate-700 shadow-sm backdrop-blur hover:bg-white"
        >
          <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} />
          <span>build {bundleId.slice(0, 7)}</span>
        </button>
      ) : (
        <div className="w-72 rounded-lg border border-slate-300 bg-white/95 p-3 text-slate-800 shadow-xl backdrop-blur">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span
                className={`inline-block h-2 w-2 rounded-full ${dotColor}`}
              />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                Version diagnostics
              </span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              ×
            </button>
          </div>

          <Row
            label="Bundle (JS)"
            value={bundleId}
            hint="The build id baked into the running JS."
          />
          <Row
            label="Active SW"
            value={activeSwId}
            hint="The SW currently controlling this tab."
            warn={activeSwId !== serverSwId && activeSwId !== "…"}
          />
          <Row
            label="Server SW"
            value={serverSwId}
            hint="The SW the server is shipping right now."
            warn={bundleId !== serverSwId && serverSwId !== "…"}
          />

          <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-1.5 text-[10px] text-slate-600">
            {allMatch ? (
              <span className="text-emerald-700">
                ✓ Bundle, active SW, and server SW all match — you are on the
                latest deploy.
              </span>
            ) : !bundleVsServer ? (
              <span className="text-rose-700">
                Bundle ≠ Server SW. The JS this tab is running is from a
                different deploy than what the server is currently shipping.
              </span>
            ) : (
              <span className="text-amber-700">
                Active SW ≠ Server SW. A newer SW is available — click Force
                Refresh.
              </span>
            )}
          </div>

          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              onClick={handleForceRefresh}
              disabled={busy}
              className="flex-1 rounded bg-rose-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
            >
              {busy ? "Refreshing…" : "Force Refresh"}
            </button>
            <button
              type="button"
              onClick={handleCopy}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
            >
              Copy
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  hint,
  warn,
}: {
  label: string;
  value: string;
  hint?: string;
  warn?: boolean;
}) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">
          {label}
        </div>
        {hint && (
          <div className="text-[9px] text-slate-400 leading-tight">{hint}</div>
        )}
      </div>
      <code
        className={`truncate rounded px-1.5 py-0.5 text-[10px] ${
          warn
            ? "bg-rose-100 text-rose-800"
            : "bg-slate-100 text-slate-800"
        }`}
        title={value}
      >
        {value}
      </code>
    </div>
  );
}

export default VersionBadge;
