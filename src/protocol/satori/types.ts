// Satori protocol types

export interface SatoriEvent {
  id: string;
  type: string;
  timestamp: number;
  [key: string]: unknown;
}
