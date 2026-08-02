import { Game } from './Game';
import { installTestHooks } from './debug/TestHooks';

const container = document.getElementById('app')!;
const hudCanvas = document.getElementById('hud') as HTMLCanvasElement;

const harness = new URLSearchParams(location.search).has('harness');

const game = new Game(container, hudCanvas);
installTestHooks(game);

if (!harness) {
  game.start();
} else {
  // The harness drives the loop itself so frames are reproducible.
  game.engine.setDeterministic(true);
  console.log('[wb] harness mode - deterministic stepping');
}

// Expose for console poking during development.
(window as unknown as { game: Game }).game = game;
