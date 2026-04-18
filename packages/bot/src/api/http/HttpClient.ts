// HTTP Client utility - encapsulates fetch with better error handling and features

import { connect as tlsConnect } from 'node:tls';
import { logger } from '@/utils/logger';

export interface HttpClientOptions {
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  defaultTimeout?: number;
  retries?: number;
  retryDelay?: number;
  /**
   * When enabled, performs a TLS socket pre-flight check before each request
   * to verify the remote server is reachable. Aborts early if the TCP+TLS
   * handshake cannot complete within `connectTimeout` ms.
   */
  tlsPreCheck?: boolean;
  /** Timeout (ms) for the TLS pre-flight handshake. Default: 10000 (10s). */
  connectTimeout?: number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  /**
   * Note: The body is converted to string internally because fetch API requires
   * body to be string, FormData, Blob, etc. Objects are automatically serialized.
   */
  body?: unknown;
  timeout?: number;
  signal?: AbortSignal;
  retries?: number;
}

export class HttpClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly statusText?: string,
    public readonly response?: unknown,
  ) {
    super(message);
    this.name = 'HttpClientError';
  }
}

/**
 * HTTP Client utility
 * Encapsulates fetch API with better error handling, timeout management, and response processing
 */
export class HttpClient {
  private baseURL: string;
  private defaultHeaders: Record<string, string>;
  private defaultTimeout: number;
  private retries: number;
  private retryDelay: number;
  private tlsPreCheck: boolean;
  private connectTimeout: number;

  constructor(options: HttpClientOptions = {}) {
    this.baseURL = options.baseURL || '';
    this.defaultHeaders = options.defaultHeaders || {};
    // Default timeout: 120 seconds (2 minutes) - suitable for AI processing
    // Individual providers can override with longer timeouts for specific operations
    // (e.g., video generation may need 2 minutes)
    this.defaultTimeout = options.defaultTimeout || 120000; // 120 seconds default
    this.retries = options.retries ?? 0;
    this.retryDelay = options.retryDelay || 1000;
    this.tlsPreCheck = options.tlsPreCheck ?? false;
    this.connectTimeout = options.connectTimeout ?? 10000;
  }

  /**
   * Make a generic HTTP request.
   * Timeout covers the ENTIRE request-response cycle (fetch + body parsing).
   */
  async request<T = unknown>(url: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method || 'GET';
    const timeout = options.timeout ?? this.defaultTimeout;
    const retries = options.retries ?? this.retries;

    // Build full URL
    const fullUrl = this.buildUrl(url);

    // TLS pre-flight check: verify server is reachable before sending request
    if (this.tlsPreCheck) {
      await this.runTlsPreCheck(fullUrl);
    }

    // Merge headers
    const headers = this.mergeHeaders(options.headers);
    const body = this.prepareBody(options.body);

    // Log request in debug mode
    logger.debug(`[HttpClient] ${method} ${fullUrl}`);

    let lastError: Error | null = null;

    // Retry logic
    for (let attempt = 0; attempt <= retries; attempt++) {
      // Create timeout controller that covers BOTH fetch and body parsing.
      // Previously the timeout was cleared after fetch returned headers, leaving
      // body reading uncovered — causing "The operation timed out." errors for
      // slow-response APIs (e.g. image generation).
      const { controller, clear: clearTimer } = this.createTimeoutController(timeout, options.signal);

      try {
        const response = await this.executeFetch(fullUrl, {
          method,
          headers,
          body,
          signal: controller.signal,
        });

        // Parse response — timeout is still active during body reading
        const data = await this.parseResponse<T>(response);

        // Clear timeout only after body is fully read
        clearTimer();

        // Log response in debug mode
        logger.debug(`[HttpClient] ${method} ${fullUrl} - ${response.status}:${response.statusText}`);

        return data;
      } catch (error) {
        clearTimer();

        // Convert AbortError/TimeoutError to HttpClientError with clear message
        const isTimeout = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

        lastError = isTimeout
          ? new HttpClientError(`Request timeout after ${timeout}ms`)
          : error instanceof Error
            ? error
            : new Error(String(error));

        // Don't retry on client errors (4xx)
        if (error instanceof HttpClientError && error.status && error.status >= 400 && error.status < 500) {
          throw error;
        }

        // If this is the last attempt, throw the error
        if (attempt === retries) {
          throw lastError;
        }

        // Wait before retrying
        const delay = this.retryDelay * (attempt + 1); // Exponential backoff
        logger.debug(`[HttpClient] Request failed, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
        await this.sleep(delay);
      }
    }

    // This should never be reached, but TypeScript needs it
    throw lastError || new Error('Request failed');
  }

  /**
   * Make a GET request
   */
  async get<T = unknown>(url: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> {
    return this.request<T>(url, { ...options, method: 'GET' });
  }

  /**
   * Make a POST request
   *
   * @param url - Request URL (relative to baseURL if configured)
   * @param body - Request body (object will be JSON.stringify'd automatically)
   * @param options - Additional request options (headers, timeout, etc.)
   *
   * @example
   * ```typescript
   * // Object body - automatically serialized to JSON
   * await httpClient.post('/api/endpoint', { key: 'value' });
   *
   * // String body - sent as-is
   * await httpClient.post('/api/endpoint', 'raw string');
   *
   * // With custom timeout
   * await httpClient.post('/api/endpoint', data, { timeout: 300000 });
   * ```
   */
  async post<T = unknown>(url: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> {
    return this.request<T>(url, { ...options, method: 'POST', body });
  }

  /**
   * Make a PUT request
   */
  async put<T = unknown>(url: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> {
    return this.request<T>(url, { ...options, method: 'PUT', body });
  }

  /**
   * Make a DELETE request
   */
  async delete<T = unknown>(url: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> {
    return this.request<T>(url, { ...options, method: 'DELETE' });
  }

  /**
   * Make a PATCH request
   */
  async patch<T = unknown>(url: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> {
    return this.request<T>(url, { ...options, method: 'PATCH', body });
  }

  /**
   * Get a streaming response
   */
  async stream(url: string, options: RequestOptions = {}): Promise<ReadableStream<Uint8Array>> {
    const method = options.method || 'GET';
    const timeout = options.timeout ?? this.defaultTimeout;

    // Build full URL
    const fullUrl = this.buildUrl(url);

    // TLS pre-flight check
    if (this.tlsPreCheck) {
      await this.runTlsPreCheck(fullUrl);
    }

    // Prepare body first to determine if we need to set Content-Type
    const body = this.prepareBody(options.body);
    const bodyWasObject = options.body !== undefined && options.body !== null && typeof options.body !== 'string';

    // Merge headers and auto-set Content-Type for JSON bodies
    const headers = this.mergeHeaders(options.headers);
    // Automatically set Content-Type: application/json if body is an object (was JSON.stringify'd)
    // and Content-Type is not already set
    if (bodyWasObject && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }

    // Log request in debug mode
    logger.debug(`[HttpClient] ${method} ${fullUrl} (streaming)`);

    // For streaming, timeout only covers initial fetch (body is consumed by caller)
    const { controller, clear: clearTimer } = this.createTimeoutController(timeout, options.signal);

    let response: Response;
    try {
      response = await this.executeFetch(fullUrl, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimer();
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw new HttpClientError(`Request timeout after ${timeout}ms`);
      }
      throw error;
    }

    if (!response.ok) {
      // Read error body while timeout is still active to avoid hanging
      const errorText = await response.text().catch(() => 'Unknown error');
      clearTimer();
      throw new HttpClientError(
        `HTTP ${response.status} ${response.statusText}: ${errorText}`,
        response.status,
        response.statusText,
      );
    }

    // Clear timeout only after confirming response is OK
    clearTimer();

    if (!response.body) {
      throw new HttpClientError('Response body is null');
    }

    return response.body;
  }

  /**
   * Create an AbortController with a timeout, optionally combining with an external signal.
   * Caller is responsible for calling `clear()` when the full operation completes.
   */
  private createTimeoutController(
    timeout: number,
    externalSignal?: AbortSignal,
  ): { controller: AbortController; clear: () => void } {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let onExternalAbort: (() => void) | undefined;
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        onExternalAbort = () => controller.abort();
        externalSignal.addEventListener('abort', onExternalAbort);
      }
    }

    return {
      controller,
      clear: () => {
        clearTimeout(timeoutId);
        if (onExternalAbort && externalSignal) {
          externalSignal.removeEventListener('abort', onExternalAbort);
        }
      },
    };
  }

  /**
   * Execute the actual fetch request. Caller manages timeout via signal.
   */
  private async executeFetch(
    url: string,
    options: {
      method: string;
      headers: Record<string, string>;
      body: string | undefined;
      signal: AbortSignal;
    },
  ): Promise<Response> {
    return fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: options.signal,
    });
  }

  /**
   * Parse response based on content type
   */
  private async parseResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      let errorMessage = `HTTP ${response.status} ${response.statusText}`;
      let errorData: unknown;

      try {
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          errorData = await response.json();
          const errorObj = errorData as {
            message?: string | { message?: string };
            error?: string | { message?: string };
            detail?: string;
            statusCode?: number;
          };
          const msg =
            errorObj.message ||
            errorObj.error ||
            errorObj.detail ||
            (errorObj.statusCode ? `HTTP ${errorObj.statusCode}` : null);
          // Ensure we always pass a string (API may return error as nested object)
          if (msg != null) {
            errorMessage =
              typeof msg === 'string' ? msg : ((msg as { message?: string }).message ?? JSON.stringify(msg));
          }
        } else {
          const text = await response.text();
          errorData = text;
          if (text) {
            errorMessage = text.length > 500 ? `${text.substring(0, 500)}...` : text;
          }
        }
      } catch (_parseError) {
        // Try to get error text even if JSON parsing fails
        try {
          const text = await response.clone().text();
          if (text) {
            errorData = text;
            errorMessage = text.length > 500 ? `${text.substring(0, 500)}...` : text;
          }
        } catch {
          // Ignore parsing errors, use default error message
        }
      }

      throw new HttpClientError(errorMessage, response.status, response.statusText, errorData);
    }

    // Parse response based on content type
    const contentType = response.headers.get('content-type');

    // Handle JSON response (only if content-type explicitly says JSON)
    if (contentType?.includes('application/json')) {
      try {
        return (await response.json()) as T;
      } catch (error) {
        throw new HttpClientError(
          `Failed to parse JSON response: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // For unknown or binary content-types, read as ArrayBuffer first to check for ZIP magic bytes
    // This ensures we can detect ZIP files even if content-type is wrong
    const shouldCheckForZip =
      !contentType ||
      contentType.includes('application/octet-stream') ||
      contentType.includes('application/zip') ||
      contentType.includes('audio/') ||
      contentType.includes('image/');

    if (shouldCheckForZip) {
      try {
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        // ZIP files start with "PK" (0x50 0x4B)
        const isZip = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
        if (isZip || contentType?.includes('application/zip')) {
          return arrayBuffer as unknown as T;
        }
        // If it's an image/audio and not ZIP, return as ArrayBuffer
        if (contentType && (contentType.includes('audio/') || contentType.includes('image/'))) {
          return arrayBuffer as unknown as T;
        }
        // For application/octet-stream, return as ArrayBuffer
        if (contentType?.includes('application/octet-stream')) {
          return arrayBuffer as unknown as T;
        }
        // If we read it as ArrayBuffer but it's not binary, convert to text
        // This handles cases where content-type is missing but response is text
        try {
          return buffer.toString('utf-8') as unknown as T;
        } catch {
          return arrayBuffer as unknown as T;
        }
      } catch (error) {
        throw new HttpClientError(
          `Failed to read binary response: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Return text response as fallback for known text content-types
    try {
      return (await response.text()) as unknown as T;
    } catch (error) {
      throw new HttpClientError(`Failed to read response: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Build full URL from base URL and path
   */
  private buildUrl(url: string): string {
    if (!this.baseURL) {
      return url;
    }

    // If URL is already absolute, return as is
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }

    // If URL is empty, return baseURL as is (no trailing slash)
    if (!url) {
      return this.baseURL;
    }

    // Remove leading slash from URL if baseURL ends with slash
    const base = this.baseURL.endsWith('/') ? this.baseURL.slice(0, -1) : this.baseURL;
    const path = url.startsWith('/') ? url : `/${url}`;

    return `${base}${path}`;
  }

  /**
   * Merge default headers with request headers
   */
  private mergeHeaders(requestHeaders?: Record<string, string>): Record<string, string> {
    return {
      ...this.defaultHeaders,
      ...requestHeaders,
    };
  }

  /**
   * Prepare request body (JSON stringify if object)
   */
  private prepareBody(body: unknown): string | undefined {
    if (body === undefined || body === null) {
      return undefined;
    }

    if (typeof body === 'string') {
      return body;
    }

    // JSON stringify objects
    return JSON.stringify(body);
  }

  /**
   * Sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Verify that a TLS connection to the given host:port can be established
   * within `connectTimeout` ms. Returns true if the handshake succeeds.
   */
  private checkTlsConnection(hostname: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = tlsConnect({ host: hostname, port, rejectUnauthorized: true }, () => {
        // TLS handshake succeeded
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });

      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, this.connectTimeout);

      socket.on('error', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(false);
      });

      socket.on('close', () => {
        clearTimeout(timer);
      });
    });
  }

  /**
   * Run TLS pre-flight check for a URL. Throws HttpClientError if unreachable.
   */
  private async runTlsPreCheck(url: string): Promise<void> {
    let hostname: string;
    let port: number;
    try {
      const parsed = new URL(url);
      hostname = parsed.hostname;
      port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    } catch {
      return; // can't parse URL, skip check
    }

    // Only check HTTPS endpoints
    if (!url.startsWith('https://')) {
      return;
    }

    const ok = await this.checkTlsConnection(hostname, port);
    if (!ok) {
      throw new HttpClientError(`TLS connect to ${hostname}:${port} failed within ${this.connectTimeout}ms`);
    }
    logger.debug(`[HttpClient] TLS pre-check passed for ${hostname}:${port}`);
  }
}
