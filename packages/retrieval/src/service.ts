// A separate entry because RetrievalService is a tsyringe singleton, and tsyringe needs
// reflect-metadata the moment it is imported; the root barrel stays loadable without it.
export { RetrievalService } from './RetrievalService';
