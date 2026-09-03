// Bootstrap placeholder for GRV-0001: proves the build, the base path and the build SHA plumbing.
declare const __BUILD_SHA__: string;

const app = document.getElementById('app');
if (app) app.textContent = `GRAVITON  build ${__BUILD_SHA__}`;
