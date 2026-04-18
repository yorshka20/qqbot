// Config utilities - shared logic for enable/disable operations

/**
 * Update enabled/disabled lists for a name (command or plugin)
 * @param name - Name to enable/disable
 * @param enabled - Current enabled list
 * @param disabled - Current disabled list
 * @param enable - Whether to enable (true) or disable (false)
 * @returns Updated enabled and disabled lists
 */
export function updateEnabledDisabled(
  name: string,
  enabled: string[],
  disabled: string[],
  enable: boolean,
): { enabled: string[]; disabled: string[] } {
  const lowerName = name.toLowerCase();

  if (enable) {
    // Remove from disabled list if present
    const newDisabled = disabled.filter((n) => n !== lowerName);
    // Add to enabled list if not present
    const newEnabled = enabled.includes(lowerName) ? enabled : [...enabled, lowerName];
    return { enabled: newEnabled, disabled: newDisabled };
  } else {
    // Remove from enabled list if present
    const newEnabled = enabled.filter((n) => n !== lowerName);
    // Add to disabled list if not present
    const newDisabled = disabled.includes(lowerName) ? disabled : [...disabled, lowerName];
    return { enabled: newEnabled, disabled: newDisabled };
  }
}
