import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base, deliberately. It is what lets one identical build run from a
  // GitHub Pages subpath, from inside an itch.io zip, and from the desktop
  // wrapper's app:// scheme without a per-target rebuild.
  base: './',
  server: { port: 5173, host: true },
  build: {
    target: 'es2022',
    // Off for release: the sourcemap was 3.8 MB of a 4.5 MB dist, i.e. 84% of
    // what a visitor downloads is debug data they cannot use. Flip to 'hidden'
    // if you ever want maps uploaded to an error reporter but not served.
    sourcemap: false,
  },
});
