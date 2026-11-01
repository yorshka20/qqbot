/** JSON body of every 4xx / 5xx answer from the bot's HTTP API. */
export interface ErrorResponse {
  error: string;
}

/** Page of rows returned by the cluster history endpoints. */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}
