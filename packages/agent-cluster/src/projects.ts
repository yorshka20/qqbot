// A separate entry because ProjectRegistry is a tsyringe singleton, and tsyringe needs
// reflect-metadata the moment it is imported; the root barrel stays loadable without it.
export { type ProjectEntry, ProjectRegistry, type ProjectRegistryOptions } from './codingAgent/ProjectRegistry';
