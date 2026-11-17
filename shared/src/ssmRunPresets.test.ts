import { describe, it, expect } from 'vitest';
import { SSM_RUN_PRESETS, getPresetVariant } from './ssmRunPresets.js';

/**
 * Extension #4 (SSM Run Command Linux+Windows) — `getPresetVariant()` is the ONLY table lookup
 * between platform and command variant (document + commands). This test locks down that behavior
 * for all 5 presets so an accidental swap of the linux/windows branch is caught right at the
 * `shared` layer.
 */
describe('getPresetVariant', () => {
  it('returns the correct linux variant (AWS-RunShellScript) for all 5 presets', () => {
    for (const preset of SSM_RUN_PRESETS) {
      const variant = getPresetVariant(preset, 'linux');
      expect(variant).toBe(preset.linux);
      expect(variant.documentName).toBe('AWS-RunShellScript');
    }
  });

  it('returns the correct windows variant (AWS-RunPowerShellScript) for all 5 presets', () => {
    for (const preset of SSM_RUN_PRESETS) {
      const variant = getPresetVariant(preset, 'windows');
      expect(variant).toBe(preset.windows);
      expect(variant.documentName).toBe('AWS-RunPowerShellScript');
    }
  });

  it('the linux and windows variants of the same preset do not share a commands array', () => {
    for (const preset of SSM_RUN_PRESETS) {
      expect(preset.linux.commands).not.toEqual(preset.windows.commands);
    }
  });
});
