import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";

/**
 * Resolve a unique build identifier used for cache-busting the service worker
 * and any other artifacts that must change on every deploy.
 *
 * Priority:
 *   1. Explicit env vars (Vercel / CI provides these)
 *   2. `git rev-parse --short HEAD` (local dev with git available)
 *   3. Current timestamp (last-resort fallback)
 */
function resolveBuildId(): string {
  const fromEnv =
    process.env.VITE_BUILD_ID ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    process.env.COMMIT_REF ||
    process.env.SOURCE_VERSION;
  if (fromEnv) return fromEnv.slice(0, 12);

  try {
    const sha = execSync("git rev-parse --short=12 HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (sha) return sha;
  } catch {
    /* git not available — fall through */
  }

  return `t${Date.now().toString(36)}`;
}

const BUILD_ID = resolveBuildId();

/**
 * Vite plugin: rewrite `__BUILD_ID__` placeholders inside `public/sw.js` and
 * `index.html` so the service worker's CACHE_VERSION updates automatically on
 * every deploy.
 *
 * Without this, the SW source is byte-identical between deploys and browsers
 * never re-install it, so users keep getting stale cached assets.
 *
 * - Dev: middleware intercepts `/sw.js` requests and serves the rewritten
 *   version so dev mirrors prod behavior.
 * - Build: `writeBundle` overwrites `dist/sw.js` AFTER Vite has copied
 *   `public/sw.js` verbatim, replacing the placeholder with the real id.
 *   (Using writeBundle instead of emitFile avoids a Rollup filename
 *   conflict because Vite already copied public/sw.js.)
 * - index.html: `transformIndexHtml` rewrites `?v=__BUILD_ID__` query
 *   strings on icon/manifest links so they bust browser cache too.
 */
function buildIdInjectionPlugin(): Plugin {
  const swPath = path.resolve(__dirname, "public/sw.js");
  const versionJsonPath = path.resolve(__dirname, "public/version.json");
  const inject = (src: string) => src.replace(/__BUILD_ID__/g, BUILD_ID);

  return {
    name: "famous-build-id-injection",
    configResolved() {
      // eslint-disable-next-line no-console
      console.log(`[build-id] CACHE_VERSION=${BUILD_ID}`);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();
        const url = req.url.split("?")[0];
        if (url === "/sw.js") {
          try {
            const src = fs.readFileSync(swPath, "utf-8");
            res.setHeader("Content-Type", "application/javascript");
            res.setHeader("Cache-Control", "no-store");
            res.end(inject(src));
            return;
          } catch (err) {
            return next(err as Error);
          }
        }
        if (url === "/version.json") {
          try {
            const src = fs.readFileSync(versionJsonPath, "utf-8");
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(inject(src));
            return;
          } catch (err) {
            return next(err as Error);
          }
        }
        return next();
      });
    },
    writeBundle(options) {
      const outDir = options.dir || path.resolve(__dirname, "dist");
      try {
        const outSw = path.join(outDir, "sw.js");
        const swSrc = fs.readFileSync(swPath, "utf-8");
        fs.writeFileSync(outSw, inject(swSrc), "utf-8");
        // eslint-disable-next-line no-console
        console.log(
          `[build-id] wrote ${outSw} with CACHE_VERSION=${BUILD_ID}`
        );
      } catch (err) {
        this.warn(`Could not inject build id into sw.js: ${String(err)}`);
      }
      try {
        const outVer = path.join(outDir, "version.json");
        const verSrc = fs.readFileSync(versionJsonPath, "utf-8");
        fs.writeFileSync(outVer, inject(verSrc), "utf-8");
        // eslint-disable-next-line no-console
        console.log(
          `[build-id] wrote ${outVer} with buildId=${BUILD_ID}`
        );
      } catch (err) {
        this.warn(`Could not inject build id into version.json: ${String(err)}`);
      }
    },
    transformIndexHtml(html) {
      return inject(html);
    },
  };
}


// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react(), buildIdInjectionPlugin()],
  // Expose the build id to client code so <UpdateToast /> can display it
  // for debugging ("build a1b2c3d…").
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
