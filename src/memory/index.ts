// Memory module exports

// Re-export scope types from config for convenience
export type { CoreScope, GroupCoreScope, ParsedScope, UserCoreScope } from '@/core/config/types/memory';
export { ALL_CORE_SCOPES, GROUP_CORE_SCOPES, USER_CORE_SCOPES } from '@/core/config/types/memory';
export type { ExtractResult, MemoryExtractServiceOptions } from './MemoryExtractService';
export { MemoryExtractService } from './MemoryExtractService';
export type { FactMeta } from './MemoryFactMetaService';
export { MemoryFactMetaService } from './MemoryFactMetaService';
export type { MemoryFact, MemoryRAGSearchOptions, MemoryRAGSearchResult } from './MemoryRAGService';
export { MemoryRAGService } from './MemoryRAGService';
export type {
  MemoryLayer,
  MemorySearchResult,
  MemorySection,
  MemoryServiceOptions,
  MemorySource,
} from './MemoryService';
export { GROUP_MEMORY_USER_ID, MemoryService } from './MemoryService';
