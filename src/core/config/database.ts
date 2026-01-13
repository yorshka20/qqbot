// Database configuration

export type DatabaseType = 'sqlite' | 'mongodb';

export interface SQLiteConfig {
  path: string;
}

export interface MongoDBConfig {
  connectionString: string;
  database: string;
  options?: {
    authSource?: string;
    user?: string;
    password?: string;
  };
}

export interface DatabaseConfig {
  type: DatabaseType;
  sqlite?: SQLiteConfig;
  mongodb?: MongoDBConfig;
}
