// Command arguments parser - unified argument parsing for all commands
// All commands must use --option=value format (no spaces)

/**
 * Option type for automatic conversion
 */
export type OptionType = 'string' | 'number' | 'float' | 'boolean';

/**
 * Option definition for automatic parsing
 */
export interface OptionDefinition {
  /**
   * Target property name in the options object
   */
  property: string;
  /**
   * Type of the option value for automatic conversion
   */
  type: OptionType;
  /**
   * Alternative option names (aliases)
   */
  aliases?: string[];
}

/**
 * Parser configuration
 */
export interface ParserConfig {
  /**
   * Option definitions for automatic parsing
   * Key is the option name (as it appears in command), value is the definition
   */
  options: Record<string, OptionDefinition>;
}

/**
 * Parse command arguments with unified format
 * Format: command text --option1=value1 --option2=value2
 *
 * Rules:
 * - Parameters must start with -- (double dash)
 * - Must use = to separate option and value: --option=value
 * - No spaces allowed between option and value
 * - Text content is everything before the first --option
 */
export class CommandArgsParser {
  /**
   * Convert string value to specified type
   */
  private static convertValue(value: string, type: OptionType): string | number | boolean {
    switch (type) {
      case 'number':
        return parseInt(value, 10);
      case 'float':
        return parseFloat(value);
      case 'boolean':
        return value.toLowerCase() === 'true' || value === '1';
      case 'string':
      default:
        return value;
    }
  }

  /**
   * Generic parser that automatically handles option parsing based on configuration
   * Each command can define its own parameter configuration
   *
   * @param args - Command arguments array
   * @param config - Parser configuration with option definitions
   * @returns Object with text content and parsed options
   *
   * @example
   * ```typescript
   * const config: ParserConfig = {
   *   options: {
   *     width: { property: 'width', type: 'number' },
   *     height: { property: 'height', type: 'number' },
   *     voice: { property: 'voice', type: 'string' },
   *   },
   * };
   * const result = CommandArgsParser.parse(args, config);
   * // result.text contains text content
   * // result.options contains parsed options with correct types
   * ```
   */
  static parse<T extends Record<string, unknown>>(
    args: string[],
    config: ParserConfig,
  ): {
    text: string;
    options: T;
  } {
    const options: Record<string, unknown> = {};
    const textParts: string[] = [];

    // Build reverse mapping: option name -> definition
    const optionMap = new Map<string, OptionDefinition>();
    for (const [optionName, definition] of Object.entries(config.options)) {
      optionMap.set(optionName, definition);
      // Also register aliases
      if (definition.aliases) {
        for (const alias of definition.aliases) {
          optionMap.set(alias, definition);
        }
      }
    }

    for (const arg of args) {
      // Check if this is an option (starts with --)
      if (arg.startsWith('--')) {
        // Parse --option=value format or --option (for boolean flags)
        const equalIndex = arg.indexOf('=');

        let optionName: string;
        let optionValue: string | undefined;

        if (equalIndex === -1) {
          // No = found, treat as boolean flag (value is undefined)
          optionName = arg.slice(2); // Remove --
          optionValue = undefined;
        } else {
          // Has =, extract option name and value
          optionName = arg.slice(2, equalIndex); // Remove -- and get option name
          optionValue = arg.slice(equalIndex + 1); // Get value after =
        }

        // Find option definition
        const definition = optionMap.get(optionName);
        if (definition) {
          // For boolean type without value, default to true
          if (definition.type === 'boolean' && optionValue === undefined) {
            options[definition.property] = true;
          } else if (optionValue !== undefined) {
            // Convert value to appropriate type
            const convertedValue = this.convertValue(optionValue, definition.type);

            // Validate number types
            if ((definition.type === 'number' || definition.type === 'float') && isNaN(convertedValue as number)) {
              // Invalid number, skip
              continue;
            }

            // Set the property with the correct name
            options[definition.property] = convertedValue;
          } else {
            // Non-boolean option without value, skip
            continue;
          }
        }
        // Unknown options are silently ignored
      } else {
        // This is part of the text content
        textParts.push(arg);
      }
    }

    const text = textParts.join(' ');

    return { text, options: options as T };
  }
}
