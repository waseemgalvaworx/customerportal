/// <reference types="vite/client" />

// Injected by the Vite `famous-build-id-injection` plugin in vite.config.ts.
// Contains the git commit short SHA (or a timestamp fallback) of the build
// currently running in the browser. Used by <UpdateToast /> to confirm which
// version is active.
declare const __BUILD_ID__: string;
