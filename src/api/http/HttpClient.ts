// HTTP Client utility - encapsulates fetch with better error handling and features

import { logger } from '@/utils/logger';

export interface HttpClientOptions {
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  defaultTimeout?: number;
  retries?: number;
  retryDelay?: number;
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

  constructor(options: HttpClientOptions = {}) {
    this.baseURL = options.baseURL || '';
    this.defaultHeaders = options.defaultHeaders || {};
    // Default timeout: 120 seconds (2 minutes) - suitable for AI processing
    // Individual providers can override with longer timeouts for specific operations
    // (e.g., video generation may need 2 minutes)
    this.defaultTimeout = options.defaultTimeout || 120000; // 120 seconds default
    this.retries = options.retries ?? 0;
    this.retryDelay = options.retryDelay || 1000;
  }

  /**
   * Make a generic HTTP request
   */
  async request<T = unknown>(url: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method || 'GET';
    const timeout = options.timeout ?? this.defaultTimeout;
    const retries = options.retries ?? this.retries;

    // Build full URL
    const fullUrl = this.buildUrl(url);

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
    logger.debug(`[HttpClient] ${method} ${fullUrl}`, {
      headers: this.sanitizeHeaders(headers),
      body: body ? (typeof body === 'string' ? body.substring(0, 200) : '...') : undefined,
    });

    let lastError: Error | null = null;

    // Retry logic
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.executeRequest(fullUrl, {
          method,
          headers,
          body,
          timeout,
          signal: options.signal,
        });

        // Parse response
        const data = await this.parseResponse<T>(response);

        // Log response in debug mode
        logger.debug(`[HttpClient] ${method} ${fullUrl} - ${response.status}`, {
          status: response.status,
          statusText: response.statusText,
        });

        return data;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on client errors (4xx) or if signal is aborted
        if (
          (error instanceof HttpClientError && error.status && error.status >= 400 && error.status < 500) ||
          (error instanceof Error && error.name === 'AbortError')
        ) {
          throw error;
        }

        // If this is the last attempt, throw the error
        if (attempt === retries) {
          throw error;
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

    const response = await this.executeRequest(fullUrl, {
      method,
      headers,
      body,
      timeout,
      signal: options.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new HttpClientError(
        `HTTP ${response.status} ${response.statusText}: ${errorText}`,
        response.status,
        response.statusText,
      );
    }

    if (!response.body) {
      throw new HttpClientError('Response body is null');
    }

    return response.body;
  }

  /**
   * Execute the actual fetch request with timeout
   */
  private async executeRequest(
    url: string,
    options: {
      method: string;
      headers: Record<string, string>;
      body: string | undefined;
      timeout: number;
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout);

    // Combine signals if both are provided
    let signal = controller.signal;
    if (options.signal) {
      // If both signals exist, abort if either is aborted
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener('abort', () => controller.abort());
      }
    }

    try {
      const response = await fetch(url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal,
      });

      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new HttpClientError(`Request timeout after ${options.timeout}ms`);
        }
        throw error;
      }

      throw new Error(`Unknown error: ${String(error)}`);
    }
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
        if (contentType && contentType.includes('application/json')) {
          errorData = await response.json();
          errorMessage =
            (errorData as { message?: string; error?: string })?.message ||
            (errorData as { error?: string })?.error ||
            errorMessage;
        } else {
          const text = await response.text();
          errorData = text;
          if (text) {
            errorMessage = text.length > 200 ? `${text.substring(0, 200)}...` : text;
          }
        }
      } catch {
        // Ignore parsing errors, use default error message
      }

      throw new HttpClientError(errorMessage, response.status, response.statusText, errorData);
    }

    // Parse response based on content type
    const contentType = response.headers.get('content-type');

    // Handle JSON response
    if (contentType && contentType.includes('application/json')) {
      try {
        return (await response.json()) as T;
      } catch (error) {
        throw new HttpClientError(
          `Failed to parse JSON response: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Handle binary response (ArrayBuffer)
    if (
      contentType &&
      (contentType.includes('audio/') ||
        contentType.includes('image/') ||
        contentType.includes('application/octet-stream'))
    ) {
      try {
        return (await response.arrayBuffer()) as unknown as T;
      } catch (error) {
        throw new HttpClientError(
          `Failed to read binary response: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Return text response as fallback
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
   * Sanitize headers for logging (remove sensitive data)
   */
  private sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const sanitized = { ...headers };
    const sensitiveKeys = ['authorization', 'api-key', 'x-api-key', 'access-token', 'token'];

    for (const key of Object.keys(sanitized)) {
      if (sensitiveKeys.some((sensitive) => key.toLowerCase().includes(sensitive))) {
        sanitized[key] = '***';
      }
    }

    return sanitized;
  }

  /**
   * Sleep utility for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
