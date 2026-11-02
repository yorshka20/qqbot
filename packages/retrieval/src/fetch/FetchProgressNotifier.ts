/** Told which pages are about to be fetched, so the caller can show progress to the user. */
export interface FetchProgressNotifier {
  onFetchingUrls(titles: string[]): void;
}
