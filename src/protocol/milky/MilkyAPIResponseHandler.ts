// Milky API response handler utilities
// Handles parsing and validation of Milky API responses

import { logger } from '@/utils/logger';
import type { MilkyAPIResponse } from './types';

/**
 * Utility class for handling Milky API responses
 * Provides type-safe response parsing and error handling
 */
export class MilkyAPIResponseHandler {
  /**
   * Type guard to check if response is Milky API response format
   * @param data Unknown data to check
   * @returns True if data matches MilkyAPIResponse format
   */
  static isMilkyAPIResponse(data: unknown): data is MilkyAPIResponse<unknown> {
    return (
      typeof data === 'object' &&
      data !== null &&
      'code' in data &&
      typeof (data as { code: unknown }).code === 'number'
    );
  }

  /**
   * Handle HTTP response: parse JSON and validate Milky API response format
   * @param response HTTP Response object
   * @param action API action name for error context
   * @returns Parsed response data
   * @throws Error if HTTP error, JSON parsing fails, or API indicates failure
   */
  static async handleResponse<TResponse = unknown>(
    response: Response,
    action: string,
  ): Promise<TResponse> {
    // Handle HTTP errors first
    if (!response.ok) {
      await this.handleHTTPError(response);
    }

    // Parse JSON response (response.json() will throw if parsing fails)
    const data = await response.json();

    // Handle Milky API response format: { code: number, message?: string, data?: T }
    if (this.isMilkyAPIResponse(data)) {
      if (data.code === 0) {
        // Success - return the data field, or the whole response if no data field
        return (data.data ?? data) as TResponse;
      } else {
        // API error - code is not 0
        const errorMessage = data.message || 'Unknown error';
        throw new Error(`Milky API error [${data.code}]: ${errorMessage}`);
      }
    }

    // If response doesn't match Milky format, log warning and return as-is
    logger.warn(
      `[MilkyAPIResponseHandler] Response doesn't match Milky API format for action: ${action}`,
    );
    return data as TResponse;
  }

  /**
   * Handle HTTP error response
   * @param response HTTP Response object
   * @throws Error with formatted error message
   */
  static async handleHTTPError(response: Response): Promise<never> {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(
      `HTTP ${response.status} ${response.statusText}: ${errorText}`,
    );
  }
}
