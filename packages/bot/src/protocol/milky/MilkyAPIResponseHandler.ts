// Milky API response handler utilities
// Handles parsing and validation of Milky API responses

import type { MilkyAPIResponse } from './types';

/**
 * LLBot answers any exception escaping an API handler with retcode 500 `Internal error: <message>`
 * (LuckyLilliaBot src/milky/common/api.ts), including the expiry of its own wait on QQ. That wait
 * does not cancel the call — QQ goes on to deliver a send after LLBot has given up on it — so such
 * a response is a lost answer, not a refusal:
 * - v7: `invoke timeout, <NT method>, <args>` (src/ntqqapi/ntcall.ts); for sendMsg the deadline is
 *   10s plus the attached file size at 256 KiB/s (src/ntqqapi/core.ts), however slow the upload is
 * - v8: `waitForSelfEcho timeout` (src/ntqqapi/api/msg.ts), raised after QQ accepted the send
 */
const ABANDONED_WAIT_RETCODE = 500;
const ABANDONED_WAIT_MESSAGE = /^Internal error: (?:invoke timeout|waitForSelfEcho timeout)\b/;

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
      'retcode' in data &&
      typeof (data as { retcode: unknown }).retcode === 'number'
    );
  }

  /** Whether the failure only reports that the implementation stopped waiting for QQ's answer. */
  static isAbandonedWait(data: unknown): data is MilkyAPIResponse<unknown> & { message: string } {
    return (
      MilkyAPIResponseHandler.isMilkyAPIResponse(data) &&
      data.retcode === ABANDONED_WAIT_RETCODE &&
      ABANDONED_WAIT_MESSAGE.test(data.message ?? '')
    );
  }

  /**
   * Handle parsed JSON data from Milky API response
   * Milky API returns: { status: string, retcode: number, data?: T }
   * @param data Parsed JSON data
   * @returns Extracted data field or the whole response
   * @throws Error if API indicates failure
   */
  static handleParsedResponse<TResponse = unknown>(data: unknown): TResponse {
    if (typeof data !== 'object' || data === null) {
      return data as TResponse;
    }

    // Handle Milky API response format: { status: string, retcode: number, data?: T }
    if (MilkyAPIResponseHandler.isMilkyAPIResponse(data)) {
      if (data.retcode === 0) {
        // Success - return the data field, or the whole response if no data field
        return (data.data ?? data) as TResponse;
      } else {
        // API error - retcode is not 0
        const errorMessage = data.message || data.status || 'Unknown error';
        throw new Error(`Milky API error [${data.retcode}]: ${errorMessage}`);
      }
    }

    return data as TResponse;
  }

  /**
   * Handle HTTP response: parse JSON and validate Milky API response format
   * @param response HTTP Response object
   * @returns Parsed response data
   * @throws Error if HTTP error, JSON parsing fails, or API indicates failure
   */
  static async handleResponse<TResponse = unknown>(response: Response): Promise<TResponse> {
    // Handle HTTP errors first
    if (!response.ok) {
      await MilkyAPIResponseHandler.handleHTTPError(response);
    }

    // Parse JSON response (response.json() will throw if parsing fails)
    const data = await response.json();

    // Handle Milky API response format
    return MilkyAPIResponseHandler.handleParsedResponse<TResponse>(data);
  }

  /**
   * Handle HTTP error response
   * @param response HTTP Response object
   * @throws Error with formatted error message
   */
  static async handleHTTPError(response: Response): Promise<never> {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${errorText}`);
  }
}
