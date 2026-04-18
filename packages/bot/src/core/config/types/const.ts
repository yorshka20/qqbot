// Common configuration types

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type BackoffStrategy = 'exponential' | 'linear';
export type APIStrategy = 'priority' | 'round-robin' | 'capability-based';
export type DeduplicationStrategy = 'first-received' | 'priority-protocol' | 'merge';
