// Vendored from thinking-orbs v0.2.0 (MIT License, © Jakub Antalik)
// Source: https://github.com/Jakubantalik/thinking-orbs
// See ./LICENSE for the full license text.

export { ThinkingOrb } from './ThinkingOrb';

export type { ThinkingOrbProps, OrbState, OrbSize, OrbTheme } from './types';

// Power-user surface: the resolved presets + raw frame painters, for
// consumers driving their own canvas outside React.
export { resolvePreset, STATE_TO_MODE, type ModeKey, type Resolved } from './presets';
export { MODE_DRAWS } from './engine/registry';
