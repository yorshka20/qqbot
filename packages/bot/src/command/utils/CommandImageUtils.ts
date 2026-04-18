/**
 * Command image utility functions
 * Static utility methods for image generation commands
 */

/**
 * Generate seed for image generation
 * If baseSeed is provided, increment from it; otherwise generate random seed
 * @param baseSeed - Base seed to increment from (optional)
 * @param index - Index offset for seed generation
 * @returns Generated seed (0 to 4294967295, 32-bit unsigned integer range)
 */
export function generateSeed(baseSeed: number | undefined, index: number): number {
  if (baseSeed !== undefined) {
    // Increment from base seed, wrap around if needed
    // Seed range: 0 to 4294967295 (32-bit unsigned integer)
    return Math.floor((baseSeed + index) % 4294967296);
  }
  // Random seed
  return Math.floor(Math.random() * 4294967295);
}
